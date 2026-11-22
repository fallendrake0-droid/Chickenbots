'use strict'
const { test } = require('node:test'); const assert = require('node:assert/strict')
const { chooseFood, validateFoodSettings } = require('../src/food')
const { betterArmour, Survival } = require('../src/survival')
const { loadConfig } = require('../src/config'); const Logger = require('../src/logger'); const { Manager } = require('../src/manager')
const gear = (name, slot, enchants = [], used = 0) => ({ name, slot, type: name, enchants, maxDurability:100, durabilityUsed:used })
const settings = { threshold:14, reserve:0, priority:'balanced' }
test('food selection is deterministic, excludes dangerous food and respects reserve except near starvation', () => {
 const bot = {food:14, inventory:{items:()=>[{name:'rotten_flesh',count:64},{name:'bread',count:2},{name:'golden_carrot',count:1}]}}
 assert.equal(chooseFood(bot, settings).item.name,'bread')
 assert.equal(chooseFood(bot, {...settings,priority:'saturation'}).item.name,'golden_carrot')
 assert.equal(chooseFood(bot, {...settings,reserve:3}).reason,'food reserve protected')
 bot.food=6; assert.ok(chooseFood(bot, {...settings,reserve:3}).item)
 bot.food=20; assert.equal(chooseFood(bot, settings).item,null)
 assert.throws(()=>validateFoodSettings({...settings,threshold:20}),/threshold/); assert.throws(()=>validateFoodSettings({...settings,priority:'x'}),/priority/)
})
test('armour upgrades are conservative around enchantments, binding, unknown and worn items', () => {
 const iron=gear('iron_helmet',5), diamond=gear('diamond_helmet',9)
 assert.equal(betterArmour(diamond,iron,'head'),true)
 assert.equal(betterArmour(gear('diamond_helmet',9,[],99),iron,'head'),false)
 assert.equal(betterArmour(diamond,gear('iron_helmet',5,[{name:'protection',lvl:4}]),'head'),false)
 assert.equal(betterArmour(diamond,gear('iron_helmet',5,[{name:'binding_curse',lvl:1}]),'head'),false)
 assert.equal(betterArmour(diamond,{name:'turtle_helmet'},'head'),false)
 assert.equal(betterArmour(gear('diamond_helmet',9,[{name:'protection',lvl:4}]),gear('iron_helmet',5,[{name:'protection',lvl:4}]),'head'),true)
})
test('mocked equipment action excludes work and stale disconnect completions', async () => {
 const config=loadConfig({BOT_AUTH_ENABLED:'false'}); const manager=new Manager(config,new Logger(config)); const c=manager.controllers.get('______'); c.state='CONNECTED'; c.authState='DISABLED'
 const item=gear('diamond_helmet',9); const slots=[]; let finish
 c.bot={food:20,inventory:{slots,items:()=>[item]},getEquipmentDestSlot:()=>5,equip:()=>new Promise(resolve=>{finish=resolve}),clearControlStates(){},quit(){},pathfinder:{setGoal(){}}}
 const run=c.survival.run(); assert.equal(c.survival.busy,true); assert.throws(()=>c.work.start('dirt'),/busy/); assert.throws(()=>manager.team.start('dirt'),/wait/)
 c.stop(); finish(); await run; assert.equal(c.survival.busy,false); assert.equal(c.survival.lastError,null); manager.shutdown()
})
test('mocked armour confirmation and failures are reported independently', async () => {
 const config=loadConfig({BOT_AUTH_ENABLED:'false'}); const manager=new Manager(config,new Logger(config)); const c=manager.controllers.get('______'); c.state='CONNECTED'; c.authState='DISABLED'; const slots=[]; const item=gear('iron_helmet',9)
 c.bot={food:20,inventory:{slots,items:()=>[item]},getEquipmentDestSlot:()=>5,equip:async()=>{slots[5]=item},clearControlStates(){},quit(){},pathfinder:{setGoal(){}}}; await c.survival.run(); assert.equal(c.survival.snapshot().equipment.head.name,'iron_helmet'); c.survival.reset()
 slots[5]=null; c.bot.equip=async()=>{}; await c.survival.run(); assert.match(c.survival.lastError,/did not confirm/); assert.equal(c.survival.busy,false); manager.shutdown()
})
