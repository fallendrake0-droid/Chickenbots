'use strict'
const readline = require('readline')
const { editConfig } = require('./src/configEditor')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
rl.on('SIGINT', () => rl.close())
editConfig(rl, { overrides: process.env }).then(() => rl.close()).catch(err => { console.error(`[ERROR] ${err.message}`); process.exitCode = 1; rl.close() })
