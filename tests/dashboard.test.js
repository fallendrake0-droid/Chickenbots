'use strict'
const { test } = require('node:test'); const assert = require('node:assert/strict'); const net = require('node:net'); const { io } = require('socket.io-client'); const { loadConfig } = require('../src/config'); const Logger = require('../src/logger'); const { Manager } = require('../src/manager'); const dashboard = require('../src/dashboard')
function once (object, event) { return new Promise(resolve => object.once(event, resolve)) }
test('local dashboard, two real sockets, input validation, recovery and shutdown', async t => {
 const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0,'127.0.0.1', () => { const p=s.address().port; s.close(() => resolve(p)) }) })
 const config = loadConfig({ BOT_AUTH_ENABLED:'false', DASHBOARD_PORT:String(port) }); const manager = new Manager(config, new Logger(config)); const web = dashboard(manager); await web.listen(); t.after(async () => { manager.shutdown(); await web.close() })
 const url = `http://127.0.0.1:${port}`; assert.equal((await fetch(url)).status, 200); assert.equal(await new Promise((resolve, reject) => { require('node:http').get(url, { headers:{host:'evil.example'}, agent:false }, r => { r.resume(); resolve(r.statusCode) }).on('error', reject) }), 403)
 const options = {transports:['websocket'], extraHeaders:{Origin:url}, reconnection:false}; const a=io(url, options), b=io(url, options); t.after(() => {a.close(); b.close()}); await Promise.all([once(a,'connect'),once(b,'connect')]);
 const call = data => new Promise(resolve => a.emit('action',data,resolve)); assert.match((await call({bot:'bad',action:'start'})).error,/Invalid bot/); assert.match((await call({bot:'all',action:'execute'})).error,/Invalid action/); assert.match((await call({bot:'______',action:'chat',message:'hello'})).error,/not connected/); assert.equal((await call({bot:'all',action:'stop'})).ok,true); assert.equal(manager.controllers.size,5)
 b.disconnect(); b.connect(); await once(b,'connect'); assert.equal(b.connected,true)
 const bad=io(url,{transports:['websocket'],extraHeaders:{Origin:'http://evil.example'},reconnection:false}); t.after(()=>bad.close()); await once(bad,'connect_error'); assert.equal(bad.connected,false)
})
