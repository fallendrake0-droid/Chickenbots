'use strict';

/**
 * Terminal branding.
 *
 * Keep the banner in one place and print it before the logger writes anything,
 * so startup output always reads: logo first, runtime information second.
 */
const LOGO = [
  "   ______ _     _      _                  _       _",
  "  / _____| |__ (_) ___| | _____ _ __   __| | ___ | |_",
  " | /     | '_ \\| |/ __| |/ / _ \\ '_ \\ / _` |/ _ \\| __|",
  " | |_____| | | | | (__|   <  __/ | | | (_| | (_) | |_",
  "  \\______|_| |_|_|\\___|_|\\_\\___|_| |_|\\__,_|\\___/ \\__|"
].join('\n');

const TAGLINE = 'five bots · one coordinated team · v6';

function color(code, text, enabled) {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/** Write the Chickenbots logo to a stream before any log lines. */
function printStartupBanner(stream = process.stdout) {
  const tty = Boolean(stream.isTTY);
  const colorEnabled = tty && !process.env.NO_COLOR;
  const accent = color('36', LOGO.trimEnd(), colorEnabled);
  const dim = color('2', `  ${TAGLINE}`, colorEnabled);
  stream.write(`\n${accent}\n${dim}\n\n`);
}

module.exports = { LOGO, TAGLINE, printStartupBanner };
