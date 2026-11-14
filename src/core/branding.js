// ── JOJO branding ────────────────────────────────────────────────────────────
// Prints the JOJO logo at startup.
//
// Terminals that support inline images (iTerm2, WezTerm, Kitty, VS Code's
// integrated terminal via iTerm protocol) get the real gold logo. Everything
// else — plain xterm, Windows Terminal, CI logs, etc. — gets a hand-tuned
// gold ASCII wordmark so the branding still shows up everywhere.

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'logo-small.png');

// Gold ANSI (256-color) shades used to hand-shade the ASCII wordmark so it
// reads as "gold on black" rather than flat single-color text.
const gold1 = chalk.hex('#F5D061'); // bright highlight
const gold2 = chalk.hex('#D4AF37'); // core gold
const gold3 = chalk.hex('#8A6D1D'); // shadow gold

const ASCII_LOGO = [
  '            ✦',
  '         ⎯⎯⎯⎯⎯⎯⎯',
  '       ╱           ╲',
  '      │   ██╗ ██████╗   │',
  '      │   ██║██╔═══██╗  │',
  '  ⎯   │   ██║██║   ██║  │   ⎯',
  '      │   ██║██║   ██║  │',
  '      │   ╚═╝╚██████╔╝  │',
  '       ╲      ╚═════╝  ╱',
  '         ⎯⎯⎯⎯⎯⎯⎯',
  '            ✦',
];

function shadeLine(line, i, total) {
  // Top lines skew toward the bright highlight, bottom lines toward shadow,
  // mirroring the light-from-above look of the source logo.
  const t = i / (total - 1);
  const color = t < 0.35 ? gold1 : t > 0.7 ? gold3 : gold2;
  return color(line);
}

function printAsciiBanner() {
  console.log();
  ASCII_LOGO.forEach((line, i) => {
    console.log('   ' + shadeLine(line, i, ASCII_LOGO.length));
  });
  console.log('   ' + gold2.bold('        J O J O') + chalk.gray('  ·  agent'));
  console.log();
}

// Detects terminals known to support the iTerm2 inline-image escape sequence
// (OSC 1337). This covers iTerm2 itself, WezTerm, and recent versions of
// Kitty/Ghostty/VS Code's terminal that emulate it.
function supportsInlineImages() {
  const { TERM_PROGRAM, TERM, KITTY_WINDOW_ID } = process.env;
  if (!process.stdout.isTTY) return false;
  if (TERM_PROGRAM === 'iTerm.app') return true;
  if (TERM_PROGRAM === 'WezTerm') return true;
  if (KITTY_WINDOW_ID) return true;
  if (TERM_PROGRAM === 'vscode') return true; // VS Code's integrated terminal
  if (TERM === 'xterm-kitty') return true;
  return false;
}

function printInlineImage() {
  const data = fs.readFileSync(LOGO_PATH);
  const b64 = data.toString('base64');
  const seq = `\x1b]1337;File=inline=1;width=22;height=22;preserveAspectRatio=1:${b64}\x07`;
  process.stdout.write('\n' + seq + '\n');
  console.log(gold2.bold('        J O J O') + chalk.gray('  ·  agent'));
  console.log();
}

export function printLogo() {
  try {
    if (supportsInlineImages() && fs.existsSync(LOGO_PATH)) {
      printInlineImage();
      return;
    }
  } catch {
    // fall through to ASCII on any read/encoding failure
  }
  printAsciiBanner();
}

