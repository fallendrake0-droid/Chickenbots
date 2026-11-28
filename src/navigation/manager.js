'use strict';

const { config } = require('../config');
const { distance } = require('../util/vec');
const { MotionArbiter, movePriority } = require('./arbiter');
const { NavigationTelemetry } = require('./telemetry');
const { StuckDetector } = require('./stuck');
const { recoveryGoal, describeRecovery } = require('./recovery');
const { goalPosition, finitePosition, floorPosition, nearestStandable } = require('./standability');
const { routeMode, routeModeNames } = require('./policy');
const { dimensionProfile } = require('./dimension');
const { FleetCongestion } = require('./congestion');

const sleep = (ms) => new Promise((resolve) => {
  // Do not unref this timer: an awaited recovery/validation delay must keep
  // the process (and the test runner) alive until it resolves.
  setTimeout(resolve, Math.max(0, ms));
});

function hasBlockReader(reader) {
  if (!reader) return false;
  // RealBot is a facade over a live Mineflayer bot. Before spawn (or in a
  // connection unit test) there is no bot.world; validation must be reported
  // as skipped rather than interpreting every read as an unloaded chunk.
  if (reader.bot !== undefined && (!reader.bot || !reader.bot.world)) return false;
  if (typeof reader.blockAt === 'function') return true;
  // BotAdapter defines getBlock as a throwing stub. Only an override with a
  // real body counts; otherwise destination validation must honestly report
  // that it was skipped.
  return typeof reader.getBlock === 'function' && reader.getBlock.constructor && reader.getBlock !== require('../bot/adapter').BotAdapter.prototype.getBlock;
}

/**
 * Central navigation state machine.
 *
 * Validation -> arbitration -> execution attempts -> stuck/recovery ->
 * verification -> telemetry. The actual pathfinder call is injected by the
 * adapter, so MockBot and RealBot share the same policy and observable state.
 */
class NavigationManager {
  constructor({
    bot = null,
    reader = null,
    now = Date.now,
    logger = null,
    arbiter = null,
    telemetry = null,
    stuck = null,
    fleet = null,
    settings = null,
    onMotion = null,
    onRecovery = null
  } = {}) {
    const nav = config.navigation || {};
    this.bot = bot;
    this.reader = reader;
    this.now = now;
    this.logger = logger;
    this.settings = {
      strict: nav.strictDestinations !== false,
      maxDrop: nav.maxDrop === undefined ? 3 : nav.maxDrop,
      allowWater: nav.allowWater !== false,
      maxAttempts: nav.maxAttempts === undefined ? 1 : nav.maxAttempts,
      operatorAttempts: nav.operatorAttempts === undefined ? 3 : nav.operatorAttempts,
      recoveryDelayMs: nav.recoveryDelayMs === undefined ? 250 : nav.recoveryDelayMs,
      stuckWindowMs: nav.stuckWindowMs === undefined ? 2500 : nav.stuckWindowMs,
      waitForWorldMs: nav.waitForWorldMs === undefined ? 750 : nav.waitForWorldMs,
      defaultTimeoutMs: nav.defaultTimeoutMs === undefined ? 20000 : nav.defaultTimeoutMs,
      openDoors: nav.openDoors === true,
      mode: settings && settings.mode ? settings.mode : (nav.routeMode || 'balanced'),
      ...(settings || {})
    };
    this.arbiter = arbiter || new MotionArbiter({ now });
    this.telemetry = telemetry || new NavigationTelemetry({ now, bot: bot && bot.name });
    this.stuck = stuck || new StuckDetector({ now, windowMs: this.settings.stuckWindowMs });
    this.fleet = fleet || null;
    this.onMotion = onMotion;
    this.onRecovery = onRecovery;
    this.sequence = 0;
    // Bounded failure memory: a route that just failed is not retried from the
    // same stance for ever, and recovery can avoid the cell that failed.
    this.failures = new Map();
    this.failureTtlMs = 45000;
    this.lastRecovery = null;
    this.recoveryCount = 0;
    this.dimension = dimensionProfile(this._readDimension());
  }

  _readDimension() {
    try {
      if (this.bot && this.bot.bot && this.bot.bot.game) return this.bot.bot.game.dimension;
      if (this.bot && this.bot.dimension) return this.bot.dimension;
      return config.navigation && config.navigation.dimension ? config.navigation.dimension : 'overworld';
    } catch (_) { return 'overworld'; }
  }

  _failureKey(position) {
    if (!finitePosition(position)) return null;
    const at = floorPosition(position);
    return `${at.x},${at.y},${at.z}`;
  }

  _sweepFailures() {
    const now = this.now();
    for (const [key, row] of this.failures) if (now - row.at > this.failureTtlMs) this.failures.delete(key);
  }

  _recordFailure(position, result = {}) {
    const key = this._failureKey(position);
    if (!key) return;
    const prior = this.failures.get(key);
    this.failures.set(key, {
      position: floorPosition(position),
      attempts: (prior ? prior.attempts : 0) + 1,
      code: result.code || null,
      reason: result.error || result.reason || null,
      at: this.now()
    });
    // Bounded memory: 64 cells is enough to break a local loop and cannot grow
    // with the number of failed long-distance operator requests.
    while (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value);
  }

  _clearFailure(position) {
    const key = this._failureKey(position);
    if (key) this.failures.delete(key);
  }

  recentFailures() {
    this._sweepFailures();
    return [...this.failures.values()].sort((a, b) => b.at - a.at).slice(0, 8);
  }

  status() {
    return {
      enabled: true,
      owner: this.arbiter.current ? this.arbiter.current.owner : null,
      priority: this.arbiter.current ? this.arbiter.current.priority : null,
      active: Boolean(this.arbiter.current),
      settings: { ...this.settings },
      motion: this.arbiter.snapshot(),
      stuck: this.stuck.snapshot(),
      telemetry: this.telemetry.summary(),
      mode: this.lastMode || routeMode(this.settings.mode).name,
      modes: routeModeNames(),
      dimension: { ...this.dimension },
      recovery: {
        last: this.lastRecovery,
        count: this.recoveryCount,
        failures: this.recentFailures()
      },
      congestion: this.fleet ? (this.fleet.conflictsFor(this.bot && this.bot.name, this.bot && this.bot.position) || []) : []
    };
  }

  cancel(reason = 'cancelled', { token = null, dispatch = true } = {}) {
    const cancelled = this.arbiter.cancel(reason, { token });
    if (cancelled) {
      this.telemetry.event('cancelled', { reason });
      if (dispatch && typeof this.onMotion === 'function') this.onMotion(null, { cancelled: true, reason });
    }
    return cancelled;
  }

  validate(pos, options = {}) {
    if (!finitePosition(pos)) {
      return { ok: false, code: 'INVALID_DESTINATION', reason: 'invalid-position', requested: pos || null };
    }
    if (!this.settings.strict || !hasBlockReader(this.reader)) {
      return {
        ok: true, code: null, reason: 'validation-skipped', requested: floorPosition(pos),
        goal: floorPosition(pos), position: floorPosition(pos), skipped: true
      };
    }
    const mode = routeMode(options.mode || this.settings.mode || 'balanced');
    const result = goalPosition(this.reader, pos, {
      range: options.range,
      adjustY: options.adjustY,
      allowUnknown: options.allowUnloaded === true,
      maxDrop: options.maxDrop === undefined ? Math.min(this.settings.maxDrop, mode.maxDrop) : Math.min(Number(options.maxDrop), mode.maxDrop),
      allowWater: options.allowWater === undefined ? (this.settings.allowWater && mode.allowWater) : options.allowWater,
      openDoors: options.openDoors === undefined ? this.settings.openDoors === true : options.openDoors === true,
      maxNearbyRadius: options.maxNearbyRadius,
      maxScanUp: options.maxScanUp,
      maxScanDown: options.maxScanDown
    });
    if (!result.ok) {
      return {
        ...result,
        requested: result.requested || floorPosition(pos),
        code: result.code || (result.unknown ? 'DESTINATION_UNLOADED' : 'NO_STANDABLE_DESTINATION')
      };
    }
    return {
      ...result,
      requested: result.requested || floorPosition(pos),
      goal: result.goal || result.position,
      code: null
    };
  }

  /**
   * Execute a move. `execute(goal, context)` must resolve to
   * `{ok, error?, timedOut?, pathRejected?, stuck?, cancelled?, superseded?}`.
   */
  async navigate(pos, options = {}, execute = null) {
    const startedAt = this.now();
    const priorityName = options.priority || 'task';
    const priority = movePriority(priorityName);
    const owner = options.owner || String(priorityName);
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || this.settings.defaultTimeoutMs);
    const range = options.range === undefined ? 1 : Number(options.range);
    const mode = routeMode(options.mode || this.settings.mode || 'balanced');
    this.lastMode = mode.name;
    const id = this.telemetry.begin({
      from: this.bot && this.bot.position, target: pos, priority, owner, range, mode: mode.name
    });
    const finish = (result) => {
      const final = {
        ...result,
        owner,
        priority,
        target: pos ? { ...pos } : null,
        attempts: result.attempts || 1,
        durationMs: Math.max(0, this.now() - startedAt)
      };
      this.telemetry.finish(id, final);
      return final;
    };
    if (typeof execute !== 'function') return finish({ ok: false, error: 'navigation executor missing', code: 'NO_EXECUTOR' });
    if (this.bot && Number(this.bot.health) <= 0) return finish({ ok: false, error: 'bot is dead; movement refused', code: 'DEAD' });
    if (!finitePosition(pos)) {
      return finish({ ok: false, code: 'INVALID_DESTINATION', error: `invalid movement destination ${JSON.stringify(pos)}` });
    }
    if (!Number.isFinite(range) || range < 0 || range > 64) {
      return finish({
        ok: false, code: 'INVALID_RANGE',
        error: `invalid arrival range ${JSON.stringify(options.range)}; expected 0..64`,
        position: this.bot && this.bot.position ? { ...this.bot.position } : null
      });
    }

    let validation = this.validate(pos, { ...options, range, mode: mode.name });
    if (!validation.ok && validation.code === 'DESTINATION_UNLOADED' && options.waitForWorld !== false) {
      const deadline = this.now() + Math.max(0, Number(this.settings.waitForWorldMs) || 0);
      while (!validation.ok && validation.code === 'DESTINATION_UNLOADED' && this.now() < deadline) {
        await sleep(Math.min(250, Math.max(1, deadline - this.now())));
        if (this.arbiter.current && !this.arbiter.isCurrent(options.__token)) break;
        validation = this.validate(pos, { ...options, range });
      }
    }
    if (!validation.ok) {
      if (/door|gate/i.test(String(validation.reason || ''))) this.telemetry.recordCount('doorBlocked');
      return finish({
        ok: false,
        code: validation.code || 'INVALID_DESTINATION',
        error: validation.code === 'DESTINATION_UNLOADED'
          ? `destination ${floorPosition(pos).x},${floorPosition(pos).y},${floorPosition(pos).z} is in an unloaded chunk`
          : `no standable destination near ${floorPosition(pos).x},${floorPosition(pos).y},${floorPosition(pos).z}: ${validation.reason}`,
        reason: validation.reason,
        requested: validation.requested || floorPosition(pos),
        position: this.bot && this.bot.position ? { ...this.bot.position } : null,
        noPath: validation.code === 'NO_STANDABLE_DESTINATION',
        invalidDestination: validation.code === 'INVALID_DESTINATION'
      });
    }

    const mayRelocate = priority <= movePriority('task');
    let requestedGoal = validation.goal || floorPosition(pos);
    let fleetResult = { position: requestedGoal, conflicts: [] };
    if (this.fleet && this.bot && this.bot.name) {
      fleetResult = this.fleet.claim(this.bot.name, requestedGoal, {
        kind: owner, priority, mayRelocate, ttlMs: timeoutMs + 1000
      });
      if (fleetResult.relocated && validation.skipped !== true && hasBlockReader(this.reader)) {
        const relocated = nearestStandable(this.reader, fleetResult.position, {
          maxNearbyRadius: 3, maxDrop: this.settings.maxDrop, allowWater: this.settings.allowWater
        });
        requestedGoal = relocated.ok ? relocated.position : requestedGoal;
      } else if (fleetResult.relocated) {
        requestedGoal = fleetResult.position;
      }
    }

    const claim = this.arbiter.claim({
      priority, owner, timeoutMs, goal: requestedGoal,
      generation: options.generation === undefined ? null : options.generation
    });
    if (!claim.ok) {
      if (this.fleet) this.fleet.release(this.bot && this.bot.name);
      return finish({
        ok: false, superseded: true, code: 'MOVEMENT_BUSY',
        error: claim.reason, owner: claim.owner, priority: claim.priority,
        position: this.bot && this.bot.position ? { ...this.bot.position } : null
      });
    }
    const token = claim.token;
    if (typeof this.onMotion === 'function') this.onMotion(claim.motion, { token });
    this.telemetry.event('begin', { id, goal: requestedGoal, owner, priority, range, relocated: Boolean(fleetResult.relocated) });
    const startPosition = this.bot && this.bot.position ? { ...this.bot.position } : null;
    const maxAttempts = Math.max(1, Math.min(5, Number(options.attempts)
      || (priority >= movePriority('operator')
        ? this.settings.operatorAttempts
        : options.replan === true ? Math.max(2, Number(this.settings.maxAttempts) || 2) : this.settings.maxAttempts)
      || 1));
    let last = null;
    let recovered = false;
    let attempts = 0;
    // The pathfinder can report success while the entity stops a block or two
    // short of the requested stance. A one-attempt task used to surface that
    // as ARRIVAL_UNVERIFIED and abandon the move (notably the walk to home
    // storage). Give that specific outcome one more attempt from where the bot
    // actually is; every other failure keeps its configured retry budget.
    let attemptLimit = maxAttempts;
    try {
      for (let attempt = 0; attempt < attemptLimit; attempt++) {
        if (!this.arbiter.isCurrent(token)) {
          return finish({ ok: false, superseded: true, cancelled: true, error: 'movement request was superseded', attempts, position: this.bot && this.bot.position ? { ...this.bot.position } : null });
        }
        const remaining = startedAt + timeoutMs - this.now();
        if (remaining <= 100) {
          last = { ok: false, timedOut: true, error: 'path timeout' };
          break;
        }
        const recovery = attempt === 0 ? null : recoveryGoal({
          attempt: attempt - 1,
          reader: this.reader,
          target: requestedGoal,
          start: startPosition,
          range,
          maxDrop: Math.min(this.settings.maxDrop, mode.maxDrop),
          allowWater: this.settings.allowWater && mode.allowWater,
          avoid: this.recentFailures().map((row) => row.position)
        });
        if (recovery && recovery.action === 'abort') {
          last = { ok: false, error: recovery.reason || 'recovery exhausted', recovery: true };
          break;
        }
        const goal = recovery && recovery.position ? recovery.position : requestedGoal;
        attempts++;
        this.stuck.reset(this.bot && this.bot.position);
        const attemptTimeout = Math.max(250, Math.min(remaining, Math.max(1500, Math.ceil(timeoutMs / maxAttempts))));
        let result;
        try {
          result = await execute(goal, {
            attempt, timeoutMs: attemptTimeout, token, motion: claim.motion,
            goal, requested: pos, range, priority, priorityName, owner,
            generation: options.generation,
            mode: mode.name, openDoors: this.settings.openDoors === true || options.openDoors === true,
            validateGoal: (candidate) => this.validate(candidate, { ...options, range, mode: mode.name })
          });
        } catch (err) {
          result = { ok: false, error: err && err.message ? err.message : String(err) };
        }
        if (!this.arbiter.isCurrent(token)) {
          return finish({ ok: false, superseded: true, cancelled: true, error: 'movement request was superseded', attempts, recovered, position: this.bot && this.bot.position ? { ...this.bot.position } : null });
        }
        if (result && result.ok !== false) {
          const live = this.bot && this.bot.position ? { ...this.bot.position } : null;
          // The executor may legitimately resolve an exact request to a real
          // standable stance (in the air, on a block target) and reports that
          // `goal`. Judge arrival against the stance it actually reached, not
          // the raw coordinate it was asked to stand inside.
          const executedGoal = result.goal && finitePosition(result.goal) ? result.goal : goal;
          const arrived = this._arrived(live, pos, range, { ...validation, goal: executedGoal });
          const verified = validation.skipped ? null : arrived;
          // A live pathfinder can report goal_reached while the entity is still
          // several blocks away (a stale server correction, a closed door or a
          // goal node that was not standable). Treat a gross miss as a failed
          // attempt even when the caller did not request strict verification;
          // ordinary one-block corrections stay successful.
          const shortBy = Number(result.shortBy);
          const grossShort = Number.isFinite(shortBy) && shortBy > Math.max(3, range + 3) && !arrived;
          const final = {
            ok: true,
            arrived,
            verified,
            arrivalUnverified: (verificationRequired(options) || grossShort) && arrived === false,
            recovered,
            attempts,
            goal: executedGoal,
            position: live,
            relocated: Boolean(fleetResult.relocated),
            conflicts: fleetResult.conflicts,
            route: result.route || null,
            steps: result.steps,
            resumed: result.resumed,
            descended: result.descended,
            already: result.already,
            searchRadius: result.searchRadius === undefined ? null : Number(result.searchRadius),
            shortBy: Number.isFinite(shortBy) ? shortBy : null,
            timings: result.timings || null,
            code: result.code || null
          };
          if ((verificationRequired(options) || grossShort) && !arrived) {
            last = {
              ...final,
              ok: false,
              code: 'ARRIVAL_UNVERIFIED',
              error: grossShort
                ? `pathfinder reported success ${shortBy.toFixed(1)} blocks short of the destination`
                : `pathfinder reported success but the bot is not within ${range} blocks of the destination`
            };
            this.telemetry.recordCount('arrivalUnverified');
            if (attemptLimit === maxAttempts && maxAttempts < 2) attemptLimit = 2;
            if (attempt + 1 >= attemptLimit) break;
          } else {
            this._clearFailure(goal);
            if (executedGoal) this._clearFailure(executedGoal);
            if (requestedGoal) this._clearFailure(requestedGoal);
            if (recovered) this.telemetry.event('recovered', { attempts, goal: executedGoal, mode: mode.name });
            return finish({ ...final, recovered, mode: mode.name });
          }
        } else {
          last = result || { ok: false, error: 'movement failed' };
          if (!last.cancelled && !last.superseded) {
            // A no-path answer implicates the destination; a timeout or a short
            // arrival implicates where the bot actually got stuck. Remembering
            // the destination for both made recovery avoid the goal it was
            // supposed to reach.
            const failedAt = last.noPath ? goal : (last.position || (this.bot && this.bot.position) || goal);
            this._recordFailure(failedAt, last);
          }
          if (last.cancelled || last.superseded) break;
          // A deterministic no-path answer does not improve by planning the
          // same map again. The old operator ladder spent all three attempts
          // (and several seconds) on exactly the same search; fail now with the
          // pathfinder's reason and the measured planning time instead.
          if (last.noPath || last.code === 'PATH_NOT_FOUND') {
            last = {
              ...last,
              code: last.code || 'PATH_NOT_FOUND',
              error: last.error || 'pathfinder found no route to the destination'
            };
            break;
          }
        }
        if (attempt + 1 >= attemptLimit) break;
        const reason = last.stuck ? 'stuck' : last.timedOut ? 'timeout' : last.noPath ? 'no-path' : 'path-failed';
        this.recoveryCount++;
        this.lastRecovery = { at: this.now(), attempt, reason, strategy: recovery ? recovery.action : null, error: last.error || null };
        this.telemetry.event('replanned', { id, attempt, reason, strategy: recovery ? recovery.action : null, error: last.error || null });
        recovered = true;
        if (typeof this.onRecovery === 'function') {
          try { await this.onRecovery({ attempt, reason, result: last, goal: requestedGoal, recovery: describeRecovery(recovery) }); }
          catch (_) { /* recovery is best effort; the next attempt is still bounded */ }
        }
        if (this.settings.recoveryDelayMs > 0) await sleep(this.settings.recoveryDelayMs);
      }
    } finally {
      if (this.arbiter.isCurrent(token)) this.arbiter.release(token);
      if (this.fleet && this.bot && this.bot.name) this.fleet.release(this.bot.name);
      if (typeof this.onMotion === 'function') this.onMotion(null, { token });
    }
    return finish({
      ...(last || {}),
      ok: false,
      recovered,
      attempts,
      owner,
      priority,
      code: (last && last.code) || null,
      mode: mode.name,
      timings: (last && last.timings) || null,
      position: this.bot && this.bot.position ? { ...this.bot.position } : null,
      goal: requestedGoal
    });
  }

  _arrived(live, requested, range, validation) {
    if (!finitePosition(live)) return false;
    // Validation may have lifted the Y (block coordinate -> feet coordinate)
    // or found the nearest standable stance. Judge against that resolved goal;
    // comparing a feet position to the original ground-block Y would reject a
    // perfectly valid arrival by one block.
    const anchor = validation.goal || validation.position || requested;
    const tolerance = Math.max(0, Number(range) || 0) + 0.75;
    return distance(live, anchor) <= tolerance;
  }
}

function verificationRequired(options) {
  // MockBot always verifies; live pathfinder success is accepted unless the
  // caller explicitly opts into strict arrival because the server can correct
  // the final position for a tick after the goal event.
  return options.verifyArrival === true;
}

module.exports = { NavigationManager, hasBlockReader, verificationRequired, FleetCongestion };
