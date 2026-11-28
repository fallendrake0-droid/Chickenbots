'use strict';

const { BoundedEventBus } = require('../util/eventBus');

/** Internal team communication. Routine coordination never goes through
 * Minecraft chat: this bus is the source of truth. */
const MESSAGE_TYPES = Object.freeze([
  'BOT_AVAILABLE',
  'TASK_REQUESTED',
  'TASK_ACCEPTED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_RELEASED',
  'RESOURCE_NEEDED',
  'RESOURCE_AVAILABLE',
  'THREAT_DETECTED',
  'THREAT_CLEARED',
  'BOT_IN_DANGER',
  'REQUEST_ASSISTANCE',
  'ASSISTANCE_DISPATCHED',
  'TEAMMATE_SAFE',
  'RETURN_TO_BASE',
  'TEAM_REGROUP',
  'TEAM_ENABLED',
  'TEAM_DISABLED',
  'PLANNER_ENABLED',
  'PLANNER_DISABLED',
  'BUILD_PHASE_COMPLETE',
  'EXCAVATION_PHASE_COMPLETE',
  'MINING_LOCATION_DISCOVERED',
  'BED_RESERVED',
  'BED_RELEASED',
  'BOT_CONNECTED',
  'BOT_DISCONNECTED',
  'BOT_RESPAWNED',
  'LEADER_ELECTED',
  'OBJECTIVE_CREATED',
  'OBJECTIVE_COMPLETED',
  'OBJECTIVE_REOPENED',
  'ROLE_CHANGED',
  'DEADLOCK_RESOLVED',
  'OBSERVATION_SHARED',
  'TEAM_WARNING',
  'CHAT_MIRROR'
]);

class TeamComms extends BoundedEventBus {
  constructor({ maxHistory = 2000 } = {}) {
    super({ maxHistory, types: MESSAGE_TYPES, name: 'team' });
    this.chatMirror = null; // optional function set by the runtime
  }

  send(type, from, payload = {}, meta = {}) {
    const message = this.publish(type, payload, { from, ...meta });
    if (this.chatMirror && meta.chat) {
      this.chatMirror(type, from, payload);
    }
    return message;
  }

  forBot(name, limit = 25) {
    return this.history.filter((m) => m.meta.from === name || m.payload.bot === name || m.payload.to === name).slice(-limit);
  }
}

module.exports = { TeamComms, MESSAGE_TYPES };
