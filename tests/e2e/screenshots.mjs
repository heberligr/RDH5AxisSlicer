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

  // 1. T-shape with no cuts, seen from low down so the red undersides show.
  await page.selectOption('#demoSelect', 'T-shape');
  await page.click('#demoLoad');
  await camera([70, -95, 12], [0, 0, 24]);
  await shot('overhangs');

  // 2. The finished example: 3 segments.
  await page.locator('details', { hasText: 'Project' }).first().locator('summary').click();
  await page.click('#exampleLoad');
  await page.waitForFunction(() => document.querySelector('#segmentsBody').innerText.includes('3 segment(s)'));
  await page.locator('details', { hasText: 'Project' }).first().locator('summary').click();
  await camera([80, -110, 55], [0, 0, 22]);
  await shot('segments');

  // 3. Machine view of segment 1 with the hotend.
  await page.locator('.cut-list li').first().click();
  await page.locator('details', { hasText: 'Hotend / IK test' }).locator('summary').click();
  await page.click('#toolAim');
  await page.check('#machineView');
  await camera([150, -190, 70], [0, -20, 10]);
  await shot('machine_view');
} finally {
  await browser.close();
  server.close();
}
