/**
 * The screenshots in the README, taken from the real thing.
 *
 * Drives a Chromium through the Signal K admin UI: the plugin's configuration
 * page, the embedded panel with its tables and dialogs, and the paths the
 * delta poller publishes. Nothing here is drawn or mocked up — the only
 * fixture is Portainer itself, which `mock-portainer.js` plays. See README.md
 * in this directory for what has to be running first.
 *
 * Usage: node tools/screenshots/capture.mjs [--server http://127.0.0.1:3000] [--out docs/images]
 */

import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const SERVER = option('server', 'http://127.0.0.1:3000');
const OUT = option('out', 'docs/images');
const PANEL = `${SERVER}/admin/#/e/signalk_portainer`;
const CONFIG = `${SERVER}/admin/#/apps/configuration/signalk-portainer`;

// Wide enough for the Containers table's action buttons to sit on one row, and
// scaled ×2 so the screenshots stay sharp on the display most people read a
// README on. Height varies per shot: the log and console panes are sized in
// `vh`, so a shorter window is what keeps those images from being mostly empty
// terminal.
const WIDTH = 1440;
const SCALE = 2;

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: 1000 },
  deviceScaleFactor: SCALE,
});
const page = await context.newPage();

/**
 * The box around everything matching a selector, in document coordinates.
 *
 * Document rather than viewport coordinates because the shots are taken with
 * `fullPage`, which is what avoids scrolling the admin UI: its plugin page
 * re-renders on every server status update and takes the scroll position with
 * it, so a screenshot that had to scroll first would land somewhere different
 * each run.
 */
const boxOf = (selector) =>
  page.evaluate((match) => {
    const found = [...document.querySelectorAll(match)].map((element) =>
      element.getBoundingClientRect(),
    );
    if (found.length === 0) return undefined;
    return {
      top: Math.min(...found.map((rect) => rect.top)) + window.scrollY,
      bottom: Math.max(...found.map((rect) => rect.bottom)) + window.scrollY,
      left: Math.min(...found.map((rect) => rect.left)) + window.scrollX,
      right: Math.max(...found.map((rect) => rect.right)) + window.scrollX,
    };
  }, selector);

/**
 * Shoots the page, trimmed to what is actually on it.
 *
 * A panel showing six containers leaves half the window empty, and a README
 * image that is mostly background wastes the reader's screen. `bottom` names
 * the lowest element worth keeping, `top` the highest, and `column` the
 * element whose width to crop to; everything outside is cut.
 */
async function shot(name, { top, bottom, column, pad = 24, padBottom = pad } = {}) {
  const clip = { x: 0, y: 0, width: WIDTH, height: page.viewportSize().height };

  if (column) {
    const box = await boxOf(column);
    if (box) {
      clip.x = Math.max(0, Math.floor(box.left) - 16);
      clip.width = Math.min(WIDTH - clip.x, Math.ceil(box.right - box.left) + 32);
    }
  }
  const edge = async (value, side) => {
    if (typeof value === 'number') return value;
    const box = await boxOf(value);
    return box ? box[side] : undefined;
  };
  if (top !== undefined) {
    const y = await edge(top, 'top');
    if (y !== undefined) clip.y = Math.max(0, Math.floor(y) - pad);
  }
  if (bottom !== undefined) {
    const y = await edge(bottom, 'bottom');
    if (y !== undefined) clip.height = Math.ceil(y) + padBottom - clip.y;
  }

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, clip });
  process.stdout.write(`${OUT}/${name}.png\n`);
}

/** Opens the panel fresh, on the given tab, with its first poll finished. */
async function panel(tab, height = 1000) {
  await page.setViewportSize({ width: WIDTH, height });
  await page.goto(PANEL, { waitUntil: 'networkidle' });
  // The panel is a federated module the admin UI fetches after the page loads,
  // so waiting for the tab is waiting for the panel itself to arrive.
  const button = page.getByRole('button', { name: tab, exact: true });
  await button.waitFor({ state: 'visible', timeout: 60_000 });
  await button.click();
  await page.waitForSelector('table', { timeout: 60_000 });
  await page.waitForTimeout(1000);
}

const actions = (container) => page.getByRole('group', { name: `Actions for ${container}` });

// ── the panel, tab by tab ──────────────────────────────────────────────────

// Where the panel opens, and where the environment is chosen: the row in use
// carries the badge, the others carry the button that switches to them.
await panel('Environments');
await shot('panel-environments', { bottom: 'table' });

await panel('Containers');
await shot('panel-containers', { bottom: 'table' });

await panel('Stacks');
await shot('panel-stacks', { bottom: 'table' });

await panel('Images');
await shot('panel-images', { bottom: 'table' });

// ── the dialogs ────────────────────────────────────────────────────────────

// Stopping asks first, and the dialog says what stopping does rather than only
// which button was pressed.
await panel('Containers');
await actions('mosquitto').getByRole('button', { name: 'Stop' }).click();
await page.waitForTimeout(600);
await shot('panel-confirm', { bottom: '.modal-content' });
await page.getByRole('button', { name: 'Cancel' }).click();

// The log viewer, following. A few seconds is a line or two from the fixture's
// live stream, which is what makes it visibly live rather than a one-shot read.
await panel('Containers', 860);
await actions('signalk-server').getByRole('button', { name: 'Logs' }).click();
await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 30_000 });
const follow = page.getByLabel('Follow');
await follow.waitFor({ state: 'visible', timeout: 30_000 });
await follow.check();
await page.waitForTimeout(3000);
await shot('panel-logs', { bottom: '.modal-content' });
await page.keyboard.press('Escape');

// The console, with commands run in it. Typed rather than injected: the point
// of the screenshot is that the keystrokes reach the container.
await panel('Containers', 860);
await actions('signalk-server').getByRole('button', { name: 'Console' }).click();
// The terminal arrives in its own chunk and the shell in its own socket, so
// neither is there when the dialog opens. The screen is what to wait for and
// what to click: xterm's input is a textarea parked off-screen, which is
// attached long before there is anything to type into.
await page.waitForSelector('.xterm-screen', { timeout: 60_000 });
await page.getByText('Connected', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
await page.waitForTimeout(1000);
await page.locator('.xterm-screen').click();
for (const command of ['uname -a', 'ls -l /home/node/.signalk', 'df -h /']) {
  await page.keyboard.type(command, { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}
await shot('panel-console', { bottom: '.modal-content' });
await page.keyboard.press('Control+]');
await page.getByRole('button', { name: 'Close' }).first().click();

// The stack editor, holding the compose file Portainer has for the stack.
await panel('Stacks', 900);
await actions('boat-core').getByRole('button', { name: 'Edit' }).click();
// The editor opens empty and fills in when the compose file arrives.
await page.waitForFunction(
  () => (document.querySelector('.modal-content textarea')?.value.length ?? 0) > 0,
  null,
  { timeout: 30_000 },
);
await page.waitForTimeout(500);
await shot('panel-stack-editor', { bottom: '.modal-content' });

// ── the plugin's own configuration page ────────────────────────────────────

// Both configuration shots are cropped to the form itself: the plugin list
// beside it belongs to the admin UI rather than to this plugin, and takes half
// the width.
const CARD = '.card:has(#root_configuration_instances_0_name)';

await page.setViewportSize({ width: WIDTH, height: 1000 });
await page.goto(CONFIG, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await shot('plugin-config', {
  top: CARD,
  // Down to where Advanced starts: everything above it is what an operator has
  // to fill in, and everything in it is what they mostly do not.
  bottom: '#root_configuration_instances_0_advanced__title',
  column: CARD,
  pad: 12,
  padBottom: 2,
});

// The settings that decide what is published and what the panel may do,
// further down the same form.
await shot('plugin-control', {
  top: '#root_configuration_telemetry__title',
  bottom: '#root_configuration_control_watchdog_0_instance',
  column: CARD,
  pad: 12,
});

// ── what the plugin publishes, in Signal K's own data browser ──────────────

await page.setViewportSize({ width: WIDTH, height: 1200 });
await page.goto(`${SERVER}/admin/#/data/browser`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const search = page.locator('input[placeholder^="e.g. pos wind"]');
if (await search.isVisible().catch(() => false)) {
  await search.fill('docker');
}
// The browser fills in as deltas arrive, so its rows do not exist until the
// poller has published once — up to a whole poll interval after the page
// opens. They are divs rather than a table: the admin UI virtualises the list.
await page.waitForSelector('.virtual-table-row', { timeout: 90_000 });
await page.waitForTimeout(2000);
// To the last row that fits in the window: a screenshot ending halfway through
// one reads as a rendering fault rather than as a list that continues.
const lastRow = await page.evaluate((limit) => {
  const edges = [...document.querySelectorAll('.virtual-table-row')]
    .map((row) => row.getBoundingClientRect().bottom + window.scrollY)
    .filter((bottom) => bottom < limit);
  return edges.length > 0 ? Math.max(...edges) : 0;
}, page.viewportSize().height - 16);
await shot('signalk-paths', { bottom: lastRow || undefined, pad: 0 });

await browser.close();
