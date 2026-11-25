// End-to-end check: open the real page in a headless browser, use it like a
// person would, and save screenshots to tests/e2e/out/.
//   npm run test:e2e
// CDN requests are answered from node_modules (same pinned versions), so the
// test works offline and checks exactly the code in this repo.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const server = await startServer(8123);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept()); // "replace existing cuts?" prompts

await page.route('https://cdn.jsdelivr.net/npm/**', async (route) => {
  const m = new URL(route.request().url()).pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
  const file = `${ROOT}node_modules/${m[1]}/${m[2]}`;
  const type = file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
  await route.fulfill({ body: readFileSync(file), contentType: type });
});

const step = async (name, fn) => {
  await fn();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log('ok -', name);
};
const segmentsText = () => page.locator('#segmentsBody').innerText();

try {
  await page.goto('http://localhost:8123/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });

  await step('1_start_example', async () => {
    const text = await segmentsText();
    assert.match(text, /3 segment\(s\)/);
    assert.match(text, /valid print order/);
  });

  await step('2_demo_arm_overhang', async () => {
    await page.selectOption('#demoSelect', 'Cube with arm');
    await page.click('#demoLoad');
    assert.match(await segmentsText(), /overhang 200 mm/);
  });

  await step('3_add_cut', async () => {
    await page.click('#cutAdd');
    await page.fill('#cutPx', '-2.5');
    await page.press('#cutPx', 'Enter');
    await page.fill('#cutPz', '14');
    await page.press('#cutPz', 'Enter');
    await page.waitForFunction(() => document.querySelector('#segmentsBody').innerText.includes('2 segment(s)'));
    const text = await segmentsText();
    assert.match(text, /Segment 1 on segment 0/);
    assert.match(text, /valid print order/);
  });

  await step('4_machine_view', async () => {
    await page.locator('details', { hasText: 'Hotend / IK test' }).locator('summary').click();
    await page.click('#toolAim');
    await page.check('#machineView');
    const status = await page.locator('#toolStatus').innerText();
    assert.match(status, /A=90\.00\s+C=90\.00/);
  });

  await step('5_bad_cut_warning', async () => {
    await page.uncheck('#machineView');
    await page.fill('#cutNx', '0');
    await page.fill('#cutNz', '-1');
    await page.press('#cutNz', 'Enter');
    await page.waitForFunction(() => document.querySelector('#segmentsBody').innerText.includes('A-axis limits'));
  });

  await step('6_auto_segment', async () => {
    await page.uncheck('#toolShow');
    await page.selectOption('#demoSelect', 'T-shape');
    await page.click('#demoLoad');
    await page.click('#autoRun');
    await page.waitForFunction(() => document.querySelector('#autoResults').innerText.includes('cut(s) proposed'), null, { timeout: 60000 });
    assert.match(await page.locator('#autoResults').innerText(), /2 cut\(s\) proposed/);
    const text = await segmentsText();
    assert.match(text, /3 segment\(s\)/);
    assert.match(text, /valid print order/);
    assert.match(await page.locator('#autoLog').textContent(), /cut along/);
  });

  await step('7_slice_preview', async () => {
    await page.click('#sliceRun');
    await page.waitForFunction(() => document.querySelector('#sliceStats').innerText.includes('No collisions'), null, { timeout: 120000 });
    const stats = await page.locator('#sliceStats').innerText();
    assert.match(stats, /3 segment\(s\), \d+ layers, 3 table rotation/);
    await page.locator('#stepSlider').fill('150');
    assert.match(await page.locator('#stepLabel').innerText(), /Print step 151\//);
  });

  await step('8_gcode_download', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#gcodeDownload')]);
    assert.equal(download.suggestedFilename(), 'T-shape.gcode');
    const text = readFileSync(await download.path(), 'utf8');
    assert.match(text, /; ===== SEGMENT 1: A/);
    assert.ok(text.split('\n').filter((l) => l.endsWith('; rotate table')).length === 3);
  });

  await step('9_animation', async () => {
    // Every segment, with a pause before and after each tilt. Run at 4x speed.
    await page.selectOption('#animSpeed', '4');
    await page.click('#animPlay');
    const caption = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#animCaptionText').textContent),
      re.source, { timeout: 60000, polling: 30 });
    for (const re of [/Printing segment 0/, /Pause - next: Segment 1/, /Tilting: A/, /Table locked/, /Printing segment 1/,
      /Pause - next: Segment 2/, /Tilting: A/, /Table locked/, /Printing segment 2/])
      await caption(re);
    assert.match(await page.locator('#animPlay').innerText(), /Stop/);
  });

  await step('10_mobile', async () => {
    await page.click('#animPlay');
    await page.setViewportSize({ width: 390, height: 844 });
    await openExampleAgain();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no horizontal scroll on a phone');
  });

  assert.deepEqual(errors, [], `browser errors: ${errors.join(' | ')}`);
  console.log('E2E PASSED');
} finally {
  await browser.close();
  server.close();
}

async function openExampleAgain() {
  await page.locator('details', { hasText: 'Project' }).first().locator('summary').click();
  await page.click('#exampleLoad');
  await page.waitForFunction(() => document.querySelector('#segmentsBody').innerText.includes('3 segment(s)'));
}
