'use strict'
// Mineflayer must still acknowledge server teleports before plugin authentication.
// Inspect only the four vanilla player-movement packets, never chat or credentials.
const FIELDS = { position:['x','y','z'], position_look:['x','y','z','yaw','pitch'], look:['yaw','pitch'], flying:[] }
function installMovementGuard (bot, onPacket, onInvalid, options = {}) {
  const client = bot?._client
  if (!client || typeof client.write !== 'function') return
  const write = client.write
  let invalid = false
  client.write = function (name, data, ...args) {
    if (!Object.hasOwn(FIELDS, name)) return write.call(this, name, data, ...args)
    if (invalid) return
    const fields = FIELDS[name]; const bad = fields.filter(key => !Number.isFinite(data?.[key]) || (['yaw', 'pitch'].includes(key) && !Number.isFinite(Math.fround(data[key]))))
    const sample = { name, time:Date.now(), values:Object.fromEntries(fields.map(key => [key, Number.isFinite(data?.[key]) ? data[key] : String(data?.[key])])) }
    onPacket(sample)
    if (bad.length) { invalid = true; onInvalid(name, bad); return }
    const result = write.call(this, name, data, ...args)
    // Workaround for Mineflayer 4.39.0: 1.21.2+ servers may require a
    // client tick boundary between position packets. Preserve wire ordering.
    if (options.tickEnd && client.state === 'play') write.call(this, 'tick_end', {})
    return result
  }
}
module.exports = { installMovementGuard }
