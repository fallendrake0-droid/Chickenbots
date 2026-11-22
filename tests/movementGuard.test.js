'use strict'
const { test } = require('node:test'); const assert = require('node:assert/strict')
const { installMovementGuard } = require('../src/movementGuard')
const { classify } = require('../src/manager')
const { loadConfig } = require('../src/config')
test('movement guard passes finite packets and non-movement packets unchanged', () => {
 const sent=[], samples=[], errors=[]; const client={ write(name,data){ sent.push([name,data,this]) } }; installMovementGuard({_client:client}, x=>samples.push(x), (...args)=>errors.push(args))
 const valid={x:2,y:64,z:-4,yaw:30,pitch:0,flags:{onGround:true}}; client.write('position_look', valid); client.write('chat_command',{command:'test'})
 assert.equal(sent.length,2); assert.equal(sent[0][1],valid); assert.equal(sent[0][2],client); assert.equal(samples.length,1); assert.equal(errors.length,0)
})
test('non-finite rotation or position is rejected and reported, not silently sent', () => {
 for(const [name,data,field] of [['look',{yaw:NaN,pitch:0},'yaw'],['position',{x:1,y:Infinity,z:2},'y'],['position_look',{x:1,y:2,z:3,yaw:1,pitch:undefined},'pitch']]) {
  const sent=[], errors=[]; const client={write:(...args)=>sent.push(args)}; installMovementGuard({_client:client},()=>{},(...args)=>errors.push(args)); client.write(name,data); client.write(name,data); client.write('teleport_confirm',{teleportId:1}); assert.deepEqual(errors,[[name,[field]]]); assert.equal(sent.length,1); assert.equal(sent[0][0],'teleport_confirm')
 }
 assert.deepEqual(classify('Invalid move player packet received'),['INVALID_MOVEMENT_PACKET',true])
})
test('two registration arguments default and single argument remains configurable', () => {
 assert.equal(loadConfig({BOT_AUTH_PASSWORD:'test-password'}).registerConfirm,true)
 assert.equal(loadConfig({BOT_AUTH_PASSWORD:'test-password',BOT_REGISTER_CONFIRM:'false'}).registerConfirm,false)
})
test('tick-end workaround follows valid movement in order, never auth commands', () => {
 const sent=[]; const c={state:'play',write:(name,data)=>sent.push([name,data])}; installMovementGuard({_client:c},()=>{},()=>{}, {tickEnd:true}); c.write('teleport_confirm',{teleportId:2}); c.write('position_look',{x:0,y:64,z:0,yaw:0,pitch:0}); c.write('chat_command',{command:'test'}); c.write('flying',{flags:{onGround:true}})
 assert.deepEqual(sent.map(x=>x[0]),['teleport_confirm','position_look','tick_end','chat_command','flying','tick_end']); c.state='configuration'; c.write('look',{yaw:0,pitch:0}); assert.equal(sent.at(-1)[0],'look')
})
test('angles overflowing float encoding are rejected', () => { let bad; const c={write(){assert.fail('invalid angle sent')}}; installMovementGuard({_client:c},()=>{},(name,fields)=>{bad=fields}); c.write('look',{yaw:1e100,pitch:0}); assert.deepEqual(bad,['yaw']) })
test('installed 26.1 protocol codec serializes tick_end', async () => {
 const protocol=require('minecraft-protocol'); const serializer=protocol.createSerializer({state:'play',isServer:false,version:'26.1'}); const bytes=await new Promise((resolve,reject)=>{serializer.once('data',resolve); serializer.once('error',reject); serializer.write({name:'tick_end',params:{}})}); assert.equal(bytes.toString('hex'),'0d')
})
