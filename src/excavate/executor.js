'use strict';

const { distance, key } = require('../util/vec');
const { classifyBlock, isAir, isLiquid } = require('./safety');
const { iterateRegionLayers } = require('./regions');
const { CancellationToken, delay, CancelledError } = require('../util/async');

/**
 * Executes one region of an excavation plan on a bot adapter.
 *
 * Adapter contract (see src/bot/adapterContract.js):
 *   position, health, food, getBlock(pos), threatsNear(pos,r), isInventoryFull(),
 *   hasItem(name), isDiggable(name), equipBestTool(cat), digBlock(pos,opts),
 *   goTo(pos,opts), placeBlock(pos,item,opts)
 */
class ExcavationExecutor {
  constructor({
    botName,
    bot,
    plan,
    region,
    mask = null,
    taskBoard = null,
    comms = null,
    logger = null,
    options = {},
    inventoryHandler = null,
    now = () => Date.now()
  }) {
    this.botName = botName;
    this.bot = bot;
    this.plan = plan;
    this.region = region;
    this.taskBoard = taskBoard;
    this.comms = comms;
    this.logger = logger;
    this.now = now;
    this.inventoryHandler = inventoryHandler;
    this.options = {
      secondsPerBlock: 1.15,
      threatRadius: 8,
      threatPauseMs: 8000,
      maxThreatPauses: 6,
      placeTorches: true,
      torchInterval: 12,
      maxConsecutiveFailures: 8,
      progressEvery: 8,
      allowProtectedOverride: false,
      ...(plan.options || {}),
      ...options
    };
    this.options.progressEvery = Math.max(1, Math.floor(Number(this.options.progressEvery) || 8));
    this.stats = {
      attempted: 0,
      dug: 0,
      skippedAir: 0,
      skippedProtected: 0,
      skippedOre: 0,
      skippedLiquid: 0,
      skippedHazard: 0,
      failed: 0,
      torchesPlaced: 0,
      moved: 0,
      threatPauses: 0,
      inventoryOffloads: 0,
      startedAt: null,
      finishedAt: null,
      lastError: null
    };
    this.token = new CancellationToken();
    this.paused = false;
    this.pauseReasons = [];
    this._resumeWaiters = [];
    this.status = 'idle';
    this.removedKeys = new Set();
    this._throttle = 0;
    this.mask = mask;
  }

  pause(reason = 'paused by operator') {
    if (this.paused) return;
    this.paused = true;
    this.pauseReasons.push(reason);
    this.status = 'paused';
  }

  resume() {
    if (!this.paused) return;
    const wasCancelled = this.token.cancelled;
    this.paused = false;
    this.pauseReasons = [];
    if (!wasCancelled) this.status = 'running';
    const waiters = this._resumeWaiters;
    this._resumeWaiters = [];
    for (const fn of waiters) fn();
  }

  stop(reason = 'stopped') {
    this.token.cancel(reason);
    // A stopped executor must never be relabelled "running" by resume().
    this.status = 'stopped';
    this.paused = false;
    this.pauseReasons = [];
    const waiters = this._resumeWaiters;
    this._resumeWaiters = [];
    for (const fn of waiters) fn();
  }

  async _waitIfPaused() {
    while (this.paused && !this.token.cancelled) {
      await new Promise((resolve) => {
        this._resumeWaiters.push(resolve);
        const check = setInterval(() => {
          if (!this.paused || this.token.cancelled) { clearInterval(check); resolve(); }
        }, 100);
        if (check.unref) check.unref();
      });
    }
    this.token.throwIfCancelled();
  }

  _reportProgress(force = false) {
    if (!this.taskBoard) return;
    if (!force && this.stats.dug % this.options.progressEvery !== 0) return;
    const task = this.plan.taskId ? this.taskBoard.getTask(this.plan.taskId) : null;
    if (task && this.botName && task.claimedBy === this.botName) {
      this.taskBoard.updateProgress(task.id, { current: this.region.volume - this._remainingEstimate() });
      this.taskBoard.heartbeat(task.id, this.botName);
    }
    if (this.comms && (force || this.stats.dug % (this.options.progressEvery * 4) === 0)) {
      this.comms.send('EXCAVATION_PHASE_COMPLETE', this.botName, {
        progress: true,
        region: this.region.id,
        dug: this.stats.dug,
        volume: this.region.volume
      });
    }
  }

  _remainingEstimate() {
    const total = this.region.volume || 1;
    return Math.max(0, total - this.stats.dug);
  }

  _neighbourLiquid(pos) {
    const neighbours = [
      { x: pos.x + 1, y: pos.y, z: pos.z }, { x: pos.x - 1, y: pos.y, z: pos.z },
      { x: pos.x, y: pos.y, z: pos.z + 1 }, { x: pos.x, y: pos.y, z: pos.z - 1 },
      { x: pos.x, y: pos.y + 1, z: pos.z }, { x: pos.x, y: pos.y - 1, z: pos.z }
    ];
    for (const n of neighbours) {
      const b = this.bot.getBlock(n);
      if (b && isLiquid(b.name)) return n;
    }
    return null;
  }

  /** Never dig the block the bot is standing on. */
  _standingOn(pos) {
    if (!this.bot.position) return false;
    const feet = { x: Math.floor(this.bot.position.x), y: Math.floor(this.bot.position.y) - 1, z: Math.floor(this.bot.position.z) };
    return feet.x === pos.x && feet.y === pos.y && feet.z === pos.z;
  }

  async _moveAwayFrom(pos) {
    const candidates = [
      { x: pos.x + 2, y: pos.y + 1, z: pos.z },
      { x: pos.x - 2, y: pos.y + 1, z: pos.z },
      { x: pos.x, y: pos.y + 1, z: pos.z + 2 },
      { x: pos.x, y: pos.y + 1, z: pos.z - 2 },
      // The last block in a pit is often under the bot's feet after the floor
      // around it has been removed. Stepping down to the next solid layer is a
      // legitimate way off the column.
      { x: pos.x + 1, y: pos.y, z: pos.z },
      { x: pos.x - 1, y: pos.y, z: pos.z },
      { x: pos.x, y: pos.y, z: pos.z + 1 },
      { x: pos.x, y: pos.y, z: pos.z - 1 },
      { x: pos.x + 1, y: pos.y + 1, z: pos.z },
      { x: pos.x - 1, y: pos.y + 1, z: pos.z },
      { x: pos.x, y: pos.y + 1, z: pos.z + 1 },
      { x: pos.x, y: pos.y + 1, z: pos.z - 1 }
    ];
    for (const c of candidates) {
      const result = await this.bot.goTo(c, { range: 1, adjustY: true, token: this.token, timeoutMs: 5000 }).catch(() => null);
      this.stats.moved++;
      if (result && result.ok && !this._standingOn(pos)) return true;
    }
    return false;
  }

  /**
   * Move to a stance from which `pos` can be dug. A block coordinate is not a
   * stance: targeting it directly made pathfinding choose the surface while the
   * bot fell further and further behind the layer being excavated. Candidates
   * are the cell above the target (standing on it), the four neighbours on the
   * target's layer, and the same cells one level up. Every candidate is
   * validated by the adapter's navigation layer before it is used.
   */
  async _ensureReach(pos) {
    if (!this.bot.position || distance(this.bot.position, pos) <= 4.4) return true;
    const candidates = [
      { x: pos.x, y: pos.y + 1, z: pos.z },
      { x: pos.x + 1, y: pos.y + 1, z: pos.z },
      { x: pos.x - 1, y: pos.y + 1, z: pos.z },
      { x: pos.x, y: pos.y + 1, z: pos.z + 1 },
      { x: pos.x, y: pos.y + 1, z: pos.z - 1 },
      { x: pos.x + 1, y: pos.y, z: pos.z },
      { x: pos.x - 1, y: pos.y, z: pos.z },
      { x: pos.x, y: pos.y, z: pos.z + 1 },
      { x: pos.x, y: pos.y, z: pos.z - 1 }
    ];
    let tried = 0;
    for (const candidate of candidates) {
      if (tried >= 4) break;
      const block = this.bot.getBlock(candidate);
      if (!block || isLiquid(block.name)) continue;
      if (!['air', 'cave_air', 'void_air', 'water'].includes(block.name)) continue;
      tried++;
      const nav = await this.bot.goTo(candidate, { range: 0, token: this.token, timeoutMs: 12000, adjustY: true });
      this.stats.moved++;
      if (nav && nav.ok && distance(this.bot.position, pos) <= 5) return true;
    }
    // A failed relocation may still have brought the bot within digging reach.
    return distance(this.bot.position, pos) <= 5;
  }

  /**
   * Final pass over blocks still inside reach. The layer walk may have
   * navigated away from a corner, or failed to relocate while the block was
   * actually only a few blocks away; a player finishes those by hand rather
   * than reporting the site complete with a visible pillar.
   */
  async _sweepReachable() {
    let removed = 0;
    for (let pass = 0; pass < 3 && !this.token.cancelled; pass++) {
      let changed = false;
      for (const pos of iterateRegionLayers(this.region.box, { order: 'top-down', serpentine: true })) {
        if (this.token.cancelled) break;
        if (this.mask && !this.mask.includes(pos)) continue;
        if (this._standingOn(pos)) {
          await this._moveAwayFrom(pos);
          if (this._standingOn(pos)) continue;
        }
        const block = this.bot.getBlock(pos);
        if (!block || isAir(block.name) || isLiquid(block.name)) continue;
        const cls = classifyBlock(block.name, this.options);
        if (!cls.excavatable) continue;
        if (!this.bot.isDiggable(block.name)) continue;
        if (distance(this.bot.position, pos) > 4.9) {
          // The layer walk can finish at the opposite corner of a wide shaft.
          // Move to a standable cell within range of this last block, then dig
          // it instead of leaving a single visible pillar in the floor.
          const nav = await this.bot.goTo(pos, { range: 3, timeoutMs: 12000, token: this.token }).catch(() => null);
          if (!nav || nav.ok === false || distance(this.bot.position, pos) > 4.9) continue;
        }
        if (this._neighbourLiquid(pos)) continue;
        const result = await this.bot.digBlock(pos, { token: this.token, timeoutMs: 10000, region: this.region.id }).catch(() => null);
        const after = this.bot.getBlock(pos);
        if (after === null || isAir(after.name)) {
          removed++;
          changed = true;
          this.stats.attempted++;
          this.stats.dug++;
          this.removedKeys.add(key(pos));
        } else if (result && result.error) {
          this.stats.lastError = result.error;
        }
      }
      if (!changed) break;
    }
    return removed;
  }

  async _handleThreats() {
    const threats = typeof this.bot.threatsNear === 'function' ? this.bot.threatsNear(this.bot.position || this.region.box.min, this.options.threatRadius) : 0;
    if (!threats) return true;
    this.stats.threatPauses++;
    this.pause(`${threats} hostile mob(s) within ${this.options.threatRadius} blocks`);
    if (this.comms) this.comms.send('THREAT_DETECTED', this.botName, { bot: this.botName, threats, region: this.region.id, position: this.bot.position });
    const deadline = this.now() + this.options.threatPauseMs;
    while (this.now() < deadline && !this.token.cancelled) {
      const nowThreats = typeof this.bot.threatsNear === 'function' ? this.bot.threatsNear(this.bot.position || this.region.box.min, this.options.threatRadius) : 0;
      if (!nowThreats) { this.resume(); return true; }
      await delay(500, this.token);
    }
    const stillThreatened = typeof this.bot.threatsNear === 'function' ? this.bot.threatsNear(this.bot.position || this.region.box.min, this.options.threatRadius) : 0;
    if (stillThreatened > 0) {
      this.status = 'blocked';
      return false;
    }
    this.resume();
    return true;
  }

  /** Carve the shared access staircase before digging the region. Guarded by a
   * team lock so five bots never carve the same entrance at once. */
  async _carveAccess() {
    const route = this.plan.accessRoute;
    if (!route || !Array.isArray(route.steps) || !route.steps.length) return;
    let lock = null;
    if (this.taskBoard) {
      lock = this.taskBoard.acquireLock(`excavation:access:${this.plan.id}`, this.botName, { ttlMs: 120000, label: 'access route' });
      if (!lock.ok) return;
    }
    try {
      for (const pos of route.steps) {
        this.token.throwIfCancelled();
        await this._waitIfPaused();
        if (this._standingOn(pos)) continue;
        const block = this.bot.getBlock(pos);
        if (!block || isAir(block.name) || isLiquid(block.name)) continue;
        const cls = classifyBlock(block.name, this.options);
        if (!cls.excavatable) continue;
        if (!this.bot.isDiggable(block.name)) continue;
        if (!(await this._ensureReach(pos))) continue;
        await this.bot.digBlock(pos, { token: this.token, timeoutMs: 10000, access: true });
      }
    } catch (err) {
      if (err instanceof CancelledError || err.cancelled) throw err;
      this.stats.lastError = `access route: ${err.message}`;
    } finally {
      if (lock && lock.ok && this.taskBoard) this.taskBoard.releaseLock(`excavation:access:${this.plan.id}`, this.botName);
    }
  }

  /**
   * Start each worker on the surface above its own region. The access staircase
   * remains available for later descent, but a deep quarry cannot be excavated
   * top-down from a bottom corridor: the top layers are simply out of reach.
   */
  async _positionAtRegionTop() {
    const box = this.region.box;
    const target = { x: box.min.x, y: box.max.y + 1, z: box.min.z };
    await this.bot.goTo(target, {
      range: 1, adjustY: true, token: this.token, timeoutMs: 12000
    }).catch(() => null);
    this.stats.moved++;
  }

  async run() {
    this.status = this.paused ? 'paused' : 'running';
    this.stats.startedAt = this.now();
    const box = this.region.box;
    let consecutiveFailures = 0;
    let sinceTorch = 0;
    try {
      await this._carveAccess();
      await this._positionAtRegionTop();
      for (const pos of iterateRegionLayers(box, { order: 'top-down', serpentine: true })) {
        this.token.throwIfCancelled();
        await this._waitIfPaused();
        if (this.paused) continue;

        if (this.mask && !this.mask.includes(pos)) continue;
        const block = this.bot.getBlock(pos);
        if (!block || isAir(block.name)) { this.stats.skippedAir++; continue; }

        const cls = classifyBlock(block.name, this.options);
        if (!cls.excavatable) {
          if (cls.kind === 'ORE') this.stats.skippedOre++;
          else if (cls.kind === 'LIQUID') this.stats.skippedLiquid++;
          else this.stats.skippedProtected++;
          continue;
        }
        if (isLiquid(block.name)) { this.stats.skippedLiquid++; continue; }
        // Do not open a pocket into a liquid above or beside this block.
        const liquidNeighbour = this._neighbourLiquid(pos);
        if (liquidNeighbour) {
          this.stats.skippedHazard++;
          continue;
        }
        if (!this.bot.isDiggable(block.name)) {
          this.stats.skippedHazard++;
          if (this.comms) this.comms.send('TEAM_WARNING', this.botName, { bot: this.botName, warning: 'missing tool', block: block.name, position: pos });
          continue;
        }
        if (this.stats.attempted % 12 === 0 && !(await this._handleThreats())) break;
        if (this.bot.isInventoryFull && this.bot.isInventoryFull()) {
          // Offload to the home double chest and continue this same region.
          if (this.inventoryHandler) {
            const offload = await this.inventoryHandler({ botName: this.botName, bot: this.bot, region: this.region });
            if (offload && offload.ok && offload.slotsAfter && offload.slotsAfter.free > 0) {
              this.stats.inventoryOffloads++;
              continue;
            }
          }
          this.status = 'inventory-full';
          if (this.comms) this.comms.send('RESOURCE_NEEDED', this.botName, { bot: this.botName, need: 'storage', region: this.region.id });
          break;
        }
        if (this._standingOn(pos)) {
          const moved = await this._moveAwayFrom(pos);
          if (!moved) { this.stats.skippedHazard++; continue; }
        }

        if (!(await this._ensureReach(pos))) {
          this.stats.failed++;
          consecutiveFailures++;
          if (consecutiveFailures > this.options.maxConsecutiveFailures) break;
          continue;
        }

        this.stats.attempted++;
        let result;
        try {
          result = await this.bot.digBlock(pos, { token: this.token, timeoutMs: 15000, region: this.region.id });
        } catch (err) {
          if (err instanceof CancelledError || err.cancelled) throw err;
          result = { ok: false, error: err.message };
        }
        // Verify the block actually became air: never trust a dig call alone.
        const after = this.bot.getBlock(pos);
        const removed = after === null || isAir(after.name);
        if (removed) {
          this.stats.dug++;
          this.removedKeys.add(key(pos));
          consecutiveFailures = 0;
          sinceTorch++;
          if (this.options.placeTorches && sinceTorch >= this.options.torchInterval && this.bot.hasItem('torch') > 0) {
            // A torch needs a floor. The block we just dug is now air and the
            // block above it has nothing underneath, so place the torch in the
            // newly cleared cell when the cell below is still solid.
            const floor = this.bot.getBlock({ x: pos.x, y: pos.y - 1, z: pos.z });
            const torchPos = { x: pos.x, y: pos.y, z: pos.z };
            const torchCell = this.bot.getBlock(torchPos);
            // Keep the centre of the pit floor clear: that is the walking line
            // between regions, and a torch there is quickly trampled.
            const bounds = this.plan && this.plan.bounds;
            const centreX = bounds ? (bounds.min.x + bounds.max.x) / 2 : null;
            const centreZ = bounds ? (bounds.min.z + bounds.max.z) / 2 : null;
            const bottomCentre = Boolean(bounds)
              && pos.y === bounds.min.y
              && Math.abs(pos.x - centreX) <= 1
              && Math.abs(pos.z - centreZ) <= 1;
            if (!bottomCentre && floor && !isAir(floor.name) && !isLiquid(floor.name) && torchCell && isAir(torchCell.name) && this.bot.placeBlock) {
              const placed = await this.bot.placeBlock(torchPos, 'torch', { token: this.token });
              if (placed && placed.ok) { this.stats.torchesPlaced++; sinceTorch = 0; }
            }
          }
        } else {
          this.stats.failed++;
          consecutiveFailures++;
          this.stats.lastError = (result && result.error) || 'block not removed';
          if (consecutiveFailures > this.options.maxConsecutiveFailures) break;
        }
        this._reportProgress();
      }
      if (!this.token.cancelled && this.status === 'running') {
        await this._sweepReachable();
      }
      if (this.token.cancelled) this.status = 'stopped';
      else if (this.status === 'running') this.status = 'completed';
    } catch (err) {
      if (err instanceof CancelledError || err.cancelled) this.status = 'stopped';
      else { this.status = 'error'; this.stats.lastError = err.message; }
    } finally {
      this.stats.finishedAt = this.now();
      this._reportProgress(true);
    }
    return this.summary();
  }

  summary() {
    return {
      bot: this.botName,
      region: this.region.id,
      status: this.status,
      paused: this.paused,
      pauseReasons: this.pauseReasons,
      stats: { ...this.stats },
      progress: {
        dug: this.stats.dug,
        attempted: this.stats.attempted,
        volume: this.region.volume,
        ratio: Number((this.stats.dug / Math.max(1, this.region.volume)).toFixed(4))
      },
      durationMs: this.stats.startedAt ? (this.stats.finishedAt || this.now()) - this.stats.startedAt : 0
    };
  }
}

module.exports = { ExcavationExecutor };
