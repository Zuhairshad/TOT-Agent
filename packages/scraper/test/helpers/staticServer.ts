import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

/** Tiny static file server for the (future) end-to-end test. Serves `root`; ignores the query string. */
export async function startStaticServer(
  root: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      let file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(path.resolve(root))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (pathname.endsWith('/')) file = path.join(file, 'index.html');
      try {
        const data = await readFile(file);
        res.writeHead(200, {
          'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        });
        res.end(data);
      } catch {
        res.writeHead(404).end('not found');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
