'use strict';

/**
 * Terminal branding.
 *
 * The banner is printed before the logger is constructed. On a real terminal it
 * clears the previous screen and renders the wordmark in bold cyan; redirected
 * output and CI logs stay plain so they remain readable and parseable.
 */
const LOGO = [
  "   _____ _    _ _____ _____ _  ________ _   _ ____   ____ _______ _____ ",
  "  / ____| |  | |_   _/ ____| |/ /  ____| \\ | |  _ \\ / __ \\__   __/ ____|",
  " | |    | |__| | | || |    | ' /| |__  |  \\| | |_) | |  | | | | | (___  ",
  " | |    |  __  | | || |    |  < |  __| | . ` |  _ <| |  | | | |  \\___ \\ ",
  " | |____| |  | |_| || |____| . \\| |____| |\\  | |_) | |__| | | |  ____) |",
  "  \\_____|_|  |_|_____\\_____|_|\\_\\______|_| \\_|____/ \\____/  |_| |_____/ "
].join("\n");

const TAGLINE = 'five bots · one coordinated team · v6';

function style(code, text, enabled) {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/** Write a clear, bold Chickenbots wordmark before any log lines. */
function printStartupBanner(stream = process.stdout) {
  const tty = Boolean(stream.isTTY);
  const ansi = tty && !process.env.NO_COLOR;
  if (tty && !process.env.CHICKENBOTS_NO_CLEAR) stream.write('\u001b[2J\u001b[H');
  const logo = style('1;36', LOGO, ansi);
  const tagline = style('2', `  ${TAGLINE}`, ansi);
  stream.write(`\n${logo}\n${tagline}\n\n`);
}

module.exports = { LOGO, TAGLINE, printStartupBanner };
