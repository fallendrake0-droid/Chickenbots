'use strict'
const { test } = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events'); const { Vec3 } = require('vec3')
const { loadConfig } = require('../src/config'); const { Manager } = require('../src/manager'); const Logger = require('../src/logger'); const { playerCommand } = require('../src/players')
function setup () {
 const config=loadConfig({BOT_AUTH_ENABLED:'false'}); const logger=new Logger(config); logger.output=()=>{}; const manager=new Manager(config,logger); const c=manager.controllers.get('______'); c.state='CONNECTED'; c.authState='DISABLED'
 const bot=new EventEmitter(); const player={position:new Vec3(2,64,0)}; const items=[{slot:9,name:'cobblestone',type:99,count:10,metadata:0}]; const calls=[]
 Object.assign(bot,{players:{Steve:{entity:player},Away:{entity:null}},entity:{position:new Vec3(0,64,0)},inventory:{items:()=>items,selectedItem:null},food:20,health:20,game:{dimension:'overworld'},pathfinder:{setGoal:(goal,dynamic)=>calls.push({goal,dynamic}),setMovements(){},bestHarvestTool(){return null}},clearControlStates(){},lookAt:async()=>{},transfer:async opts=>calls.push({transfer:opts}),quit(){}})
 c.bot=bot; c.work.createMovements=()=>({}); return {manager,c,bot,player,items,calls}
}
const flush=()=>new Promise(r=>setImmediate(r))
test('follow starts real dynamic goal, blocks conflicting tasks and cleans up on visibility loss', () => {
 const {manager,c,bot,calls}=setup(); try { const snap=c.snapshot().players; assert.deepEqual(snap.players,[{name:'Away',visible:false},{name:'Steve',visible:true}]); playerCommand(manager,c.name,'follow',{player:'Steve'}); assert.equal(calls.at(-1).dynamic,true); assert.equal(calls.at(-1).goal.constructor.name,'GoalFollow'); assert.equal(c.playerActions.task.state,'RUNNING'); assert.throws(()=>c.work.start('dirt'),/busy/); assert.throws(()=>c.movement('forward',true),/current task/); assert.throws(()=>manager.team.start('dirt'),/Stop individual/); bot.players.Steve.entity=null; c.playerActions.monitor(); assert.equal(c.playerActions.task.state,'STOPPED'); assert.equal(calls.at(-1).goal,null); assert.equal(bot.listenerCount('path_update'),0) } finally {manager.shutdown()}
})
test('follow rejects invalid, unseen, far and self targets and handles no path', () => {
 const {manager,c,bot,player}=setup(); try { for(const name of ['Away','evil/name','______']) assert.throws(()=>c.playerActions.follow(name)); player.position=new Vec3(70,64,0); assert.throws(()=>c.playerActions.follow('Steve'),/far/); player.position=new Vec3(2,64,0); c.playerActions.follow('Steve'); bot.emit('path_update',{status:'noPath'}); assert.equal(c.playerActions.task.message,'No path to player') } finally {manager.shutdown()}
})
test('handoff is restricted to a selected safe stack and never claims pickup', async () => {
 const {manager,c,bot,calls}=setup(); try { assert.throws(()=>c.playerActions.drop('Steve','diamond',1),/safe/); assert.throws(()=>c.playerActions.drop('Steve','cobblestone',11),/stack/); assert.throws(()=>c.playerActions.drop('Steve','cobblestone',0),/Count/); c.playerActions.drop('Steve','cobblestone',3); assert.throws(()=>c.playerActions.follow('Steve'),/busy/); await flush(); assert.deepEqual(calls.at(-1).transfer,{window:bot.inventory,itemType:99,metadata:0,count:3,nbt:undefined,sourceStart:9,sourceEnd:10,destStart:-999,destEnd:-998}); assert.match(c.playerActions.task.message,/pickup is not verified/); assert.equal(c.playerActions.task.state,'COMPLETED') } finally {manager.shutdown()}
})
test('cancel before look completion prevents toss, and player leaving range prevents toss', async () => {
 const {manager,c,bot,player,calls}=setup(); try { let resolve; bot.lookAt=()=>new Promise(r=>{resolve=r}); c.playerActions.drop('Steve','cobblestone',1); c.playerActions.stop(); assert.equal(c.playerActions.busy(),true); resolve(); await flush(); assert.equal(calls.filter(c=>c.transfer).length,0); assert.equal(c.playerActions.busy(),false); bot.lookAt=async()=>{player.position=new Vec3(10,64,0)}; player.position=new Vec3(2,64,0); c.playerActions.drop('Steve','cobblestone',1); await flush(); assert.equal(c.playerActions.task.state,'FAILED'); assert.equal(calls.filter(c=>c.transfer).length,0) } finally {manager.shutdown()}
})
test('disconnect invalidates in-flight operations and stops follow without network writes', async () => {
 const {manager,c,bot,calls}=setup(); try { let resolve; bot.lookAt=()=>new Promise(r=>{resolve=r}); c.playerActions.drop('Steve','cobblestone',1); c.stop(); resolve(); await flush(); assert.equal(calls.filter(c=>c.transfer).length,0); assert.equal(c.playerActions.busy(),false) } finally {manager.shutdown()}
})
test('stopping during transfer keeps inventory locked until it settles and does not claim delivery', async () => {
 const {manager,c,bot}=setup(); try { let finish; bot.transfer=()=>new Promise(r=>{finish=r}); c.playerActions.drop('Steve','cobblestone',2); await flush(); assert.equal(typeof finish,'function'); c.playerActions.stop(); assert.equal(c.playerActions.busy(),true); assert.throws(()=>c.work.start('dirt'),/busy/); finish(); await flush(); assert.equal(c.playerActions.busy(),false); assert.equal(c.playerActions.task.state,'STOPPED'); assert.match(c.playerActions.task.message,/outcome/) } finally {manager.shutdown()}
})
test('follow stops on critical hunger and respects modified items', async () => {
 const {manager,c,bot,items}=setup(); try { c.playerActions.follow('Steve'); bot.food=5; c.playerActions.monitor(); assert.match(c.playerActions.task.message,/critical/); await flush(); bot.food=20; items[0].componentMap=new Map([['custom_name','rare']]); assert.throws(()=>c.playerActions.drop('Steve','cobblestone',1),/unmodified/); bot.inventory.selectedItem={}; items[0].componentMap.clear(); assert.throws(()=>c.playerActions.drop('Steve','cobblestone',1),/unavailable/) } finally {manager.shutdown()}
})
