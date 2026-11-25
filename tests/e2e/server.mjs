// Minimal static file server for the repo, so you can try the app locally:
//   npm run serve   ->   http://localhost:8123
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.yaml': 'text/yaml', '.png': 'image/png', '.wasm': 'application/wasm', '.stl': 'model/stl',
};

export function startServer(port = 8123) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path.startsWith('..')) return res.writeHead(403).end();
    const file = path === '' || path === '.' ? 'index.html' : path;
    try {
      const body = await readFile(join(ROOT, file));
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
  console.log('Serving on http://localhost:8123  (Ctrl+C to stop)');
}
