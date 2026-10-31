import { describe, expect, it, vi } from 'vitest';
import { Selection, ShortlistStore } from '../src/state';

const makeApi = (fail = false) => ({
  getShortlist: vi.fn(async () => ['a']),
  addShortlist: vi.fn(async () => {
    if (fail) throw new Error('nope');
  }),
  removeShortlist: vi.fn(async () => {
    if (fail) throw new Error('nope');
  }),
});

describe('ShortlistStore', () => {
  it('loads, toggles optimistically and notifies', async () => {
    const api = makeApi();
    const s = new ShortlistStore(api);
    const seen = vi.fn();
    s.subscribe(seen);
    await s.load();
    expect(s.has('a')).toBe(true);
    expect(await s.toggle('b')).toBe(true);
    expect(api.addShortlist).toHaveBeenCalledWith('b');
    expect(await s.toggle('a')).toBe(false);
    expect(api.removeShortlist).toHaveBeenCalledWith('a');
    expect(s.all()).toEqual(['b']);
    expect(seen).toHaveBeenCalled();
  });
  it('rolls back when the server call fails', async () => {
    const s = new ShortlistStore(makeApi(true));
    await expect(s.toggle('x')).rejects.toThrow('nope');
    expect(s.has('x')).toBe(false);
  });
  it('seed follows list responses', () => {
    const s = new ShortlistStore(makeApi());
    s.seed('q', true);
    expect(s.has('q')).toBe(true);
    s.seed('q', false);
    expect(s.size).toBe(0);
  });
});

describe('Selection', () => {
  it('select, select all, prune', () => {
    const sel = new Selection();
    sel.setAll(['a', 'b', 'c'], true);
    sel.set('b', false);
    expect(sel.all()).toEqual(['a', 'c']);
    sel.prune(['a']);
    expect(sel.all()).toEqual(['a']);
  });
});
