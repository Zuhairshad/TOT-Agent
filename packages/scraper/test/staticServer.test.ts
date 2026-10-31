import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startStaticServer } from './helpers/staticServer.js';

describe('static server harness', () => {
  it('serves files, 404s unknown paths, ignores query strings', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'srv-'));
    await writeFile(path.join(dir, 'search'), 'hello');
    const srv = await startStaticServer(dir);
    try {
      const ok = await fetch(`${srv.baseUrl}/search?keyword=x`);
      expect(await ok.text()).toBe('hello');
      expect((await fetch(`${srv.baseUrl}/nope`)).status).toBe(404);
    } finally {
      await srv.close();
    }
  });
});
