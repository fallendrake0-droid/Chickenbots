'use strict';

const { Logger } = require('../logger');
const { SchematicLibrary } = require('../schematics/library');
const { SchematicBuilder } = require('../builder/builder');

/**
 * Home base coordination. Selects a validated schematic from the library,
 * chooses a build origin near the team home, and runs the cooperative builder.
 * Nothing is claimed as built until the builder's world rescan passes.
 */
class HomeBaseManager {
  constructor({ bots = [], world, memory = null, taskBoard = null, ledger = null, library = null, logger = null } = {}) {
    this.bots = bots;
    this.world = world;
    this.memory = memory;
    this.taskBoard = taskBoard;
    this.ledger = ledger;
    this.library = library || new SchematicLibrary();
    this.logger = logger || new Logger({ level: 'warn' });
    this.builder = null;
    this.home = memory && memory.getHome ? memory.getHome() : null;
    this.stats = { builds: 0, completed: 0, failed: 0 };
  }

  setHome(position) {
    this.home = { position: { ...position }, setAt: Date.now() };
    if (this.memory && this.memory.setHome) this.memory.setHome(this.home);
    return this.home;
  }

  designs({ tier = null, category = null, limit = 20 } = {}) {
    return this.library.list({ tier, category, limit, maxWidth: 40 });
  }

  chooseDesign({ tier = 'Novice', category = null } = {}) {
    const designs = this.designs({ tier, category, limit: 100 });
    if (!designs.length) return null;
    return designs.sort((a, b) => a.dimensions.width * a.dimensions.length - b.dimensions.width * b.dimensions.length)[0];
  }

  plan({ tier = 'Novice', category = null, origin = null } = {}) {
    if (!this.library.loaded) return { ok: false, error: 'schematic library not generated' };
    const design = this.chooseDesign({ tier, category });
    if (!design) return { ok: false, error: `no schematic for ${tier}` };
    const schematic = this.library.build(design.id);
    const anchor = origin || (this.home && this.home.position) || (this.bots[0] ? this.bots[0].position : { x: 0, y: 64, z: 0 });
    const buildOrigin = { x: Math.floor(anchor.x) + 4, y: Math.floor(anchor.y) + 1, z: Math.floor(anchor.z) + 4 };
    const builder = new SchematicBuilder({
      schematic, origin: buildOrigin, world: this.world, bots: this.bots,
      taskBoard: this.taskBoard, ledger: this.ledger, memory: this.memory, logger: this.logger,
      buildId: `home-${design.id}`
    });
    return { ok: true, design, schematic, origin: buildOrigin, builder, analysis: builder.analyze() };
  }

  start(options = {}) {
    const plan = this.plan(options);
    if (!plan.ok) return plan;
    const started = plan.builder.start({ confirm: options.confirm });
    if (started.ok) {
      this.builder = plan.builder;
      this.stats.builds++;
    }
    return { ...started, design: plan.design, builder: plan.builder, analysis: plan.analysis };
  }

  async run(options = {}) {
    if (!this.builder) return { ok: false, error: 'no home build started' };
    const result = await this.builder.run(options);
    if (result.status.state === 'COMPLETE') this.stats.completed++;
    else if (result.status.state === 'FAILED') this.stats.failed++;
    return result;
  }

  status() {
    return {
      home: this.home && this.home.position ? this.home.position : this.home,
      design: this.builder ? { id: this.builder.schematic.id, name: this.builder.schematic.name } : null,
      build: this.builder ? this.builder.status() : null,
      // Never let a status poll parse the manifest or construct + scan the
      // custom store. Runtime.start() warms the library once; before that the
      // dashboard reports 0 designs rather than blocking the event loop.
      availableDesigns: this.library && (this.library.summaryLoaded || this.library.loadedInMemory) ? this.library.knownCount : 0,
      stats: { ...this.stats }
    };
  }
}

module.exports = { HomeBaseManager };
