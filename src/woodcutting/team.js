'use strict';

const { ROLES } = require('../actions/woodcutting');

/**
 * Fleet-wide woodcutting roles, support requests and a read-only view of the
 * shared tree leases. Roles are advisory but real: controller.tick() changes its
 * support behaviour (scouting, hauling, planting) based on the assigned role.
 */
class WoodcuttingTeam {
  constructor({ controllers = [], now = Date.now, reservations = null } = {}) {
    this.now = now;
    this.controllers = new Map();
    this.roles = new Map();
    this.requests = [];
    this.reservations = reservations;
    for (const controller of controllers) this.attach(controller);
  }

  attach(controller) {
    if (!controller || !controller.bot) return null;
    this.controllers.set(controller.bot.name, controller);
    controller.teamCoordinator = this;
    if (!this.roles.has(controller.bot.name)) this.roles.set(controller.bot.name, controller.role || 'CHOPPER');
    else controller.setRole(this.roles.get(controller.bot.name));
    return controller;
  }

  setRole(bot, role) {
    const controller = this.controllers.get(bot);
    if (!controller) return { ok: false, error: `unknown woodcutting bot '${bot}'` };
    const result = controller.setRole(role);
    if (result.ok) this.roles.set(bot, result.role);
    return result;
  }

  autoAssign({ reset = false } = {}) {
    const names = [...this.controllers.keys()];
    const assigned = {};
    names.forEach((name, index) => {
      if (!reset && this.roles.has(name) && this.roles.get(name) !== 'CHOPPER') {
        assigned[name] = this.roles.get(name);
        return;
      }
      // At most one scout, hauler and planter per five bots; everyone else
      // chops. This keeps a five-bot crew balanced without starving wood.
      const role = index === 0 ? 'SCOUT' : index === 1 ? 'HAULER' : index === 2 ? 'PLANTER' : 'CHOPPER';
      this.setRole(name, role);
      assigned[name] = role;
    });
    return { ok: true, assigned };
  }

  request(request) {
    const entry = {
      id: request.id || `wood-support-${this.requests.length + 1}`,
      bot: request.bot || null,
      kind: String(request.kind || 'HELP').toUpperCase(),
      target: request.target ? { ...request.target } : null,
      detail: request.detail ? String(request.detail).slice(0, 200) : null,
      status: 'open',
      createdAt: this.now(),
      fulfilledAt: null,
      fulfilledBy: null
    };
    this.requests.push(entry);
    if (this.requests.length > 50) this.requests.splice(0, this.requests.length - 50);
    return { ok: true, request: { ...entry } };
  }

  fulfil(id, by = null) {
    const request = this.requests.find((entry) => entry.id === id);
    if (!request) return { ok: false, error: `unknown support request '${id}'` };
    if (request.status === 'fulfilled') return { ok: true, already: true, request: { ...request } };
    request.status = 'fulfilled';
    request.fulfilledAt = this.now();
    request.fulfilledBy = by;
    return { ok: true, request: { ...request } };
  }

  support({ status = 'open', limit = 20 } = {}) {
    return this.requests
      .filter((entry) => !status || entry.status === status)
      .slice(-Math.max(1, Math.min(50, Number(limit) || 20)))
      .map((entry) => ({ ...entry, ageMs: Math.max(0, this.now() - entry.createdAt) }));
  }

  /**
   * `rows` may be supplied from the runtime's warmed controller-status cache.
   * A dashboard snapshot must never call a live controller.status() itself.
   */
  status({ rows: cachedRows = null } = {}) {
    const rows = (cachedRows || [...this.controllers.values()].map((controller) => controller.status())).map((status) => ({
      bot: status.bot, role: this.roles.get(status.bot) || status.role || 'CHOPPER',
      axe: status.axe, logs: status.logs, saplings: status.saplings,
      treesChopped: status.treesChopped, replanted: status.replanted,
      task: status.task, lifetime: status.lifetime, stopped: status.stopped
    }));
    const byRole = rows.reduce((out, row) => {
      out[row.role] = (out[row.role] || 0) + 1;
      return out;
    }, {});
    const leases = this.reservations && typeof this.reservations.status === 'function'
      ? this.reservations.status() : null;
    return {
      roles: ROLES.slice(),
      rows,
      byRole,
      reservations: leases,
      openSupport: this.support({ status: 'open' }),
      recentSupport: this.requests.slice(-10).map((entry) => ({ ...entry }))
    };
  }
}

module.exports = { WoodcuttingTeam };
