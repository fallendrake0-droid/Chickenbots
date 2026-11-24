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
    this.paused = false;
    this.pauseReasons = [];
    this.status = 'running';
    const waiters = this._resumeWaiters;
    this._resumeWaiters = [];
    for (const fn of waiters) fn();
  }

  stop(reason = 'stopped') {
    this.token.cancel(reason);
    this.status = 'stopped';
    this.resume();
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
      { x: pos.x, y: pos.y + 1, z: pos.z - 2 }
    ];
    for (const c of candidates) {
      const b = this.bot.getBlock(c);
      if (b && isAir(b.name)) {
        const result = await this.bot.goTo(c, { range: 1, token: this.token, timeoutMs: 15000 });
        this.stats.moved++;
        if (result && result.ok) return true;
      }
    }
    return false;
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
        if (this.bot.position && distance(this.bot.position, pos) > 4) {
          const nav = await this.bot.goTo(pos, { range: 2, token: this.token, timeoutMs: 12000 });
          if (!nav || !nav.ok) continue;
        }
        await this.bot.digBlock(pos, { token: this.token, timeoutMs: 10000, access: true });
      }
    } catch (err) {
      if (err instanceof CancelledError || err.cancelled) throw err;
      this.stats.lastError = `access route: ${err.message}`;
    } finally {
      if (lock && lock.ok && this.taskBoard) this.taskBoard.releaseLock(`excavation:access:${this.plan.id}`, this.botName);
    }
  }

  async run() {
    this.status = this.paused ? 'paused' : 'running';
    this.stats.startedAt = this.now();
    const box = this.region.box;
    let consecutiveFailures = 0;
    let sinceTorch = 0;
    try {
      await this._carveAccess();
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

        if (this.bot.position && distance(this.bot.position, pos) > 4) {
          const nav = await this.bot.goTo(pos, { range: 2, token: this.token, timeoutMs: 20000 });
          this.stats.moved++;
          if (!nav || !nav.ok) { this.stats.failed++; consecutiveFailures++; if (consecutiveFailures > this.options.maxConsecutiveFailures) break; continue; }
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
            const torchPos = { x: pos.x, y: pos.y + 1, z: pos.z };
            const above = this.bot.getBlock(torchPos);
            if ((!above || isAir(above.name)) && this.bot.placeBlock) {
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
