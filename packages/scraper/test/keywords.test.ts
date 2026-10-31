import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKeywords } from '../src/keywords.js';
import { KEYWORDS_PATH } from '../src/paths.js';

describe('loadKeywords', () => {
  it('loads the shipped keywords.json', async () => {
    const k = await loadKeywords(KEYWORDS_PATH);
    expect(k).toHaveLength(11);
    expect(k).toContain('motorcycle');
    expect(k).toContain('coverall');
  });
  it('de-duplicates and rejects bad shapes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kw-'));
    const f = path.join(dir, 'k.json');
    await writeFile(f, '["a","a","b"]');
    expect(await loadKeywords(f)).toEqual(['a', 'b']);
    await writeFile(f, '[]');
    await expect(loadKeywords(f)).rejects.toThrow();
    await writeFile(f, '{"x":1}');
    await expect(loadKeywords(f)).rejects.toThrow();
  });
});
