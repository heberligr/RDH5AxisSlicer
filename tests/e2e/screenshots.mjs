// Regenerate the README screenshots in docs/:   npm run docs:screenshots
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const server = await startServer(8124);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
await page.route('https://cdn.jsdelivr.net/npm/**', async (route) => {
  const m = new URL(route.request().url()).pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
  const file = `${ROOT}node_modules/${m[1]}/${m[2]}`;
  await route.fulfill({ body: readFileSync(file), contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
});

/** Move the camera: eye and target in part-frame mm. */
const camera = (eye, target) => page.evaluate(([e, t]) => {
  const { viewer } = window.slicer;
  viewer.camera.position.set(...e);
  viewer.controls.target.set(...t);
  viewer.controls.update();
}, [eye, target]);
const shot = async (name) => {
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${ROOT}docs/${name}.png` });
  console.log('saved docs/' + name + '.png');
};

try {
  await page.goto('http://localhost:8124/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
  page.on('dialog', (d) => d.accept());
  const openSection = (name) => page.locator('details', { hasText: name }).first().locator('summary').click();

  // 1. T-shape with no cuts, seen from low down so the red undersides show.
  await page.selectOption('#demoSelect', 'T-shape');
  await page.click('#demoLoad');
  await camera([70, -95, 12], [0, 0, 24]);
  await shot('overhangs');

  // 2. Auto-segment it: 3 segments.
  await page.click('#autoRun');
  await page.waitForFunction(() => document.querySelector('#autoResults').innerText.includes('proposed'));
  await camera([80, -110, 55], [0, 0, 22]);
  await shot('segments');

  // 3. Slice: toolpaths, part-way through the last segment.
  await page.click('#sliceRun');
  await page.waitForFunction(() => document.querySelector('#sliceStats').innerText.includes('collision'), null, { timeout: 120000 });
  await page.evaluate(() => {
    const plan = window.slicer.state.plan;
    plan.step = plan.steps.length - 40;
    window.slicer.renderAll();
  });
  await page.locator('#sliceStats').scrollIntoViewIfNeeded();
  await camera([70, -95, 60], [0, 0, 24]);
  await shot('toolpaths');

  // 4. Machine animation while printing the first tilted segment.
  await page.click('#animPlay');
  await page.waitForTimeout(8600);
  await camera([120, -170, 60], [0, -10, 15]);
  await page.waitForTimeout(150);
  await shot('machine_view');
} finally {
  await browser.close();
  server.close();
}
