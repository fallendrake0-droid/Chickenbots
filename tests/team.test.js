'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { Work } = require('../src/work')
const { TeamManager } = require('../src/team')
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
async function until (condition) { for (let i = 0; i < 300 && !condition(); i++) await tick(); assert.ok(condition(), 'condition did not become true') }
function fixture (count = 5) {
  const blocks = new Map(); const diggers = []; const controllers = new Map(); const manager = { controllers, logger: { clean: s => String(s), log () {} }, emit () {} }
  for (let i = 0; i < count; i++) {
    const name = `bot${i}`; const bot = { food: 20, game: {dimension:'overworld'}, entity: {position: new Vec3(0,64,0)}, inventory: {items: () => [{name:'iron_pickaxe',type:1}]}, pathfinder: {setMovements(){},setGoal(){},bestHarvestTool:()=>({name:'iron_pickaxe',type:1}),goto:async()=>{}}, findBlocks: ({matching}) => [...blocks.values()].filter(matching).map(b=>b.position), blockAt: p => blocks.get(`${p.x},${p.y},${p.z}`) || {name:'air',diggable:false}, canDigBlock:()=>true, equip:async()=>{}, dig:async block=>{ diggers.push([name,block.position.toString()]); blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`) }, clearControlStates(){}, deactivateItem(){}, stopDigging(){} }
    const c = {name,bot,state:'CONNECTED',authState:'AUTHENTICATED',manager,update(){},log(){}}; c.work = new Work(c); c.work.createMovements=()=>({}); controllers.set(name,c)
  }
  manager.team = new TeamManager(manager)
  const add = (x, name = 'stone') => { const position = new Vec3(x,64,0); blocks.set(`${x},64,0`, {position, name, diggable:true, harvestTools: name==='stone' ? {1:true} : undefined}) }
  return { manager, blocks, diggers, add }
}
test('five bots share unique claims and complete the same work order', async () => {
  const {manager, diggers, add} = fixture(); for(let i=2;i<12;i++) add(i)
  manager.team.start('stone'); await until(()=>manager.team.snapshot().state !== 'RUNNING'); const result=manager.team.snapshot()
  assert.equal(result.state,'COMPLETED'); assert.equal(result.total,10); assert.equal(result.done,10); assert.equal(result.members.length,5); assert.equal(new Set(diggers.map(x=>x[1])).size,10); assert.equal(new Set(diggers.map(x=>x[0])).size,5)
})
test('failed worker releases its claim for another bot without duplicating', async () => {
  const {manager,diggers,add}=fixture(2); for(let i=2;i<5;i++) add(i); const bad=manager.controllers.get('bot0'); bad.bot.pathfinder.bestHarvestTool=()=>null
  manager.team.start('stone'); await until(()=>manager.team.snapshot().state !== 'RUNNING'); const r=manager.team.snapshot(); assert.equal(r.state,'PARTIAL'); assert.equal(r.done,3); assert.match(r.errors.join(' '),/No suitable tool/); assert.equal(new Set(diggers.map(x=>x[1])).size,3); assert.ok(diggers.every(x=>x[0]==='bot1'))
})
test('disconnect during task releases claim for others and stale completion cannot affect totals', async () => {
  const {manager,diggers,add}=fixture(2); add(2); add(3); let release; const c=manager.controllers.get('bot0'); c.bot.dig=()=>new Promise(r=>{release=r}); manager.team.start('stone'); await until(()=>!!release); c.work.stop(true); c.state='DISCONNECTED'; c.bot=null; await until(()=>manager.team.snapshot().state!=='RUNNING'); const before=manager.team.snapshot(); assert.equal(before.done,2); assert.equal(before.state,'PARTIAL'); release(); await tick(); assert.equal(manager.team.snapshot().done,2); assert.equal(new Set(diggers.map(x=>x[1])).size,2)
})
test('team stop cancels workers and stale results do not finish the order', async () => {
  const {manager,add}=fixture(2); add(2); add(3); const resolvers=[]; for(const c of manager.controllers.values()) c.bot.dig=()=>new Promise(r=>resolvers.push(r)); manager.team.start('stone'); await until(()=>resolvers.length===2); manager.team.stop(); assert.equal(manager.team.snapshot().state,'STOPPED'); for(const resolve of resolvers) resolve(); await tick(); assert.equal(manager.team.snapshot().state,'STOPPED'); assert.equal(manager.team.snapshot().done,0)
})
test('dimension, busy bot, coordinate and loaded-block safety checks', async () => {
  const {manager,add}=fixture(3); add(2); const bots=[...manager.controllers.values()]; bots[1].bot.game.dimension='nether'; bots[2].state='STOPPED'; manager.team.start('stone'); await until(()=>manager.team.snapshot().state!=='RUNNING'); assert.deepEqual(manager.team.snapshot().members,['bot0']); assert.deepEqual(manager.team.snapshot().excluded,['bot1','bot2']); bots[0].work.active={}; assert.throws(()=>manager.team.start('stone'),/Stop individual work/); bots[0].work.active=null; assert.throws(()=>manager.team.start('excavate',{from:{x:0,y:64,z:0},to:{x:100,y:64,z:0}}),/within|limited/)
})
test('unloaded blocks are skipped instead of falsely completed or hanging', async () => {
 const {manager,add}=fixture(2); add(2); for (const c of manager.controllers.values()) c.bot.blockAt=()=>null; manager.team.start('stone'); await until(()=>manager.team.snapshot().state!=='RUNNING'); const r=manager.team.snapshot(); assert.equal(r.state,'PARTIAL'); assert.equal(r.done,0); assert.equal(r.skipped,1); assert.match(r.errors.join(' '),/out of range/)
})
test('no workers or mixed invalid tasks are rejected', () => { const {manager}=fixture(2); for (const c of manager.controllers.values()) c.state='STOPPED'; assert.throws(()=>manager.team.start('stone'),/No connected/); assert.throws(()=>manager.team.start('invalid'),/Invalid work type/) })
test('team ore orders assign unique positions with valid tools', async () => {
 const {manager,blocks,diggers,add}=fixture(2); add(2,'iron_ore'); add(3,'deepslate_iron_ore'); for(const b of blocks.values()) b.harvestTools={1:true}; manager.team.start('ore_iron'); await until(()=>manager.team.snapshot().state!=='RUNNING'); const result=manager.team.snapshot(); assert.equal(result.done,2); assert.equal(result.state,'COMPLETED'); assert.equal(new Set(diggers.map(x=>x[1])).size,2)
})
test('team mining searches up to the maximum 48 blocks per bot', async () => { const {manager,add}=fixture(2); add(2); const distances=[]; for(const c of manager.controllers.values()) { const find=c.bot.findBlocks; c.bot.findBlocks=opts=>{distances.push(opts.maxDistance); return find(opts)} } manager.team.start('stone'); await until(()=>manager.team.snapshot().state !== 'RUNNING'); assert.deepEqual(distances,[48,48]) })
test('coordinator failover preserves active claims and next job uses elected dimension', async () => {
 const {manager,add}=fixture(2); add(2); add(3); const [a,b]=[...manager.controllers.values()]; let resolve; a.bot.dig=()=>new Promise(r=>{resolve=r}); manager.team.start('stone'); await until(()=>!!resolve); assert.equal(manager.team.snapshot().intel.coordinator,'bot0'); a.work.stop(true); a.state='DISCONNECTED'; a.bot=null; await until(()=>manager.team.snapshot().state!=='RUNNING'); assert.equal(manager.team.snapshot().intel.coordinator,'bot1'); assert.equal(manager.team.snapshot().done,2); resolve(); await tick(); assert.equal(manager.team.snapshot().done,2)
})
test('worker claims its nearest loaded target first', async () => {
 const {manager,add,diggers}=fixture(1); add(10); add(2); add(6); manager.team.start('stone'); await until(()=>manager.team.snapshot().state!=='RUNNING'); assert.deepEqual(diggers.map(d=>d[1]),['(2, 64, 0)','(6, 64, 0)','(10, 64, 0)'])
})
