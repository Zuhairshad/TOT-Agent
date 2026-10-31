// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { AWARD, RICH, SPARSE } from '../dev/fixtures';
import { collectConfig } from '../src/views/settings';
import { chipEditor } from '../src/ui/chips';
import { h, safeHref } from '../src/ui/dom';
import { itemsTable, tenderCard } from '../src/ui/components';
import { evidenceSection, kindLabel, versionHistory } from '../src/views/detail';
import { sourceCard } from '../src/views/scans';
import { parseHash } from '../src/router';
import { ShortlistStore } from '../src/state';
import { getToken, setToken, clearToken } from '../src/auth';
import type { TenderListItem } from '../src/api/types';

const store = () =>
  new ShortlistStore({
    getShortlist: async () => [],
    addShortlist: async () => undefined,
    removeShortlist: async () => undefined,
  });

const item = (over: Partial<TenderListItem> = {}): TenderListItem => ({
  id: 'fixture:X',
  source: 'fixture',
  title: 'FIXTURE card',
  reference: null,
  buyer: null,
  country: null,
  publishedAt: {
    value: '2026-10-01T00:00:00Z',
    originalText: null,
    status: 'published',
    ambiguous: true,
  },
  deadline: { value: null, originalText: null, status: 'not_published', ambiguous: false },
  deadlineKnown: false,
  status: 'unknown',
  noticeType: null,
  categories: ['ppe'],
  relevance: { score: 0.5, explanation: 'FIXTURE why', groups: ['ppe'] },
  estimatedValue: { amount: 1000, currency: 'EUR', originalText: null, status: 'published' },
  awardValue: { amount: 900, currency: 'EUR', originalText: null, status: 'published' },
  shortlisted: false,
  canonicalUrl: 'https://example.org/x',
  ...over,
});

describe('items table', () => {
  it('shows Not published for a missing quantity and flags needsReview', () => {
    const el = itemsTable(AWARD.items);
    const text = el.textContent ?? '';
    expect(text).toContain('Not published');
    expect(text).toContain('Needs review');
    expect(el.querySelectorAll('thead th')).toHaveLength(6);
    expect(el.querySelector('tr.needs-review')).not.toBeNull();
  });
  it('lists every column for a normal row', () => {
    const el = itemsTable(RICH.items);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(el.querySelector('td[data-label="Quantity"]')?.textContent).toBe('10');
  });
  it('empty items say Not published', () => {
    expect(itemsTable([]).textContent).toContain('Not published');
  });
});

describe('tenderCard', () => {
  const card = () => tenderCard(item(), { href: '#/x', store: store(), onError: () => undefined });
  it('shows both dates, unknown deadline, labelled values, ambiguity and why', () => {
    const t = card().textContent ?? '';
    expect(t).toContain('2026-10-01');
    expect(t).toContain('Ambiguous date');
    expect(t).toContain('Deadline unknown');
    expect(t).toContain('Deadline not published');
    expect(t).toContain('Status unknown');
    expect(t).toContain('Estimated value');
    expect(t).toContain('Contract award value');
    expect(t).toContain('Why it matched: FIXTURE why');
  });
  it('never shows 0 for an unknown value and keeps one "Value" row', () => {
    const none = {
      amount: null,
      currency: null,
      originalText: null,
      status: 'not_published' as const,
    };
    const c = tenderCard(item({ estimatedValue: none, awardValue: none }), {
      href: '#',
      store: store(),
      onError: () => undefined,
    });
    expect(c.textContent).toContain('Not published');
    expect(c.textContent).not.toMatch(/Estimated value/);
  });
  it('star toggles shortlist state and aria-pressed', async () => {
    const s = store();
    const c = tenderCard(item(), { href: '#', store: s, onError: () => undefined });
    document.body.append(c);
    const star = c.querySelector('button.star') as HTMLButtonElement;
    expect(star.getAttribute('aria-pressed')).toBe('false');
    star.click();
    await vi.waitFor(() => expect(star.getAttribute('aria-pressed')).toBe('true'));
    expect(s.has('fixture:X')).toBe(true);
  });
  it('select mode adds a checkbox and a per-tender export button', () => {
    const onChange = vi.fn();
    const onExport = vi.fn();
    const c = tenderCard(item(), {
      href: '#',
      store: store(),
      onError: () => undefined,
      select: { checked: false, onChange, onExport },
    });
    const pick = c.querySelector('input.pick') as HTMLInputElement;
    pick.checked = true;
    pick.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(true);
    const btn = [...c.querySelectorAll('button')].find(
      (b) => b.textContent === 'Export PDF',
    ) as HTMLButtonElement;
    btn.click();
    expect(onExport).toHaveBeenCalled();
  });
});

describe('detail pieces', () => {
  it('evidence is expandable (details) with quote, page and URL', () => {
    const el = evidenceSection(RICH);
    expect(el.querySelectorAll('details').length).toBeGreaterThan(0);
    expect(el.textContent).toContain('Estimated budget USD 250,000');
    expect(el.textContent).toContain('page 3');
  });
  it('version history shows old and new values for a deadline extension', () => {
    const el = versionHistory([
      { version: 1, seenAt: '2026-10-05T08:00:00Z', changes: [] },
      {
        version: 2,
        seenAt: '2026-10-30T09:00:00Z',
        changes: [
          {
            field: 'deadline',
            old: '2026-11-10T10:00:00Z',
            new: '2026-11-20T10:00:00Z',
            kind: 'deadline_extended',
          },
        ],
      },
    ]);
    expect(el.textContent).toContain('Deadline extended');
    expect(el.querySelector('.old')?.textContent).toBe('2026-11-10 10:00 UTC');
    expect(el.querySelector('.new')?.textContent).toBe('2026-11-20 10:00 UTC');
    expect(el.querySelector('li')?.textContent).toContain('Version 2'); // newest first
    expect(kindLabel('some_thing')).toBe('Some thing');
  });
  it('SPARSE record has no evidence section content', () => {
    expect(evidenceSection(SPARSE).textContent).toContain('No supporting quotes');
  });
});

describe('scans source card', () => {
  const src = (status: string) =>
    sourceCard(
      { id: 's', accessStatus: status, lastSuccessfulScan: null, lastScan: null },
      () => undefined,
    );
  it('explains blocked / login / unconfigured in plain language', () => {
    expect(src('blocked_by_challenge').textContent).toContain('Blocked by a bot challenge');
    expect(src('blocked_by_challenge').textContent).toContain('do not try to get around it');
    expect(src('login_required').textContent).toContain('Login required');
    expect(src('unconfigured').textContent).toContain('Not set up');
  });
  it('Run scan is disabled while a scan is running', () => {
    const el = sourceCard(
      {
        id: 's',
        accessStatus: 'ok',
        lastSuccessfulScan: null,
        lastScan: {
          status: 'running',
          pagesChecked: 1,
          recordsFound: 2,
          failures: [],
          coverageLimitations: [],
          finishedAt: null,
        },
      },
      () => undefined,
    );
    expect((el.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('chip editor and settings', () => {
  it('adds on Enter (no duplicates) and removes with the x button', () => {
    const changes: string[][] = [];
    const ed = chipEditor('Terms', ['a'], (v) => changes.push(v));
    document.body.append(ed.el);
    const input = ed.el.querySelector('input') as HTMLInputElement;
    input.value = 'b';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    input.value = 'B';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(ed.values()).toEqual(['a', 'b']);
    (ed.el.querySelector('button.chip-x') as HTMLButtonElement).click();
    expect(ed.values()).toEqual(['b']);
    expect(changes.at(-1)).toEqual(['b']);
  });
  it('collectConfig builds a SearchConfig from the editors', () => {
    const cfg = collectConfig(
      { groups: [], exclusions: [], countries: [], publishedSince: null },
      [{ id: 'ppe', label: 'PPE', terms: chipEditor('t', ['helmet']), ctx: chipEditor('c', []) }],
      chipEditor('e', ['waste']),
      chipEditor('c', ['Kenya']),
      '2026-09-01',
    );
    expect(cfg).toEqual({
      groups: [{ id: 'ppe', label: 'PPE', terms: ['helmet'], requireContext: [] }],
      exclusions: ['waste'],
      countries: ['Kenya'],
      publishedSince: '2026-09-01',
    });
  });
});

describe('misc', () => {
  it('safeHref only allows http(s)', () => {
    expect(safeHref('https://example.org/a')).toBe('https://example.org/a');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('nonsense')).toBeNull();
  });
  it('h() never interprets text as HTML', () => {
    expect(h('p', {}, '<img src=x onerror=alert(1)>').querySelector('img')).toBeNull();
  });
  it('parseHash routes', () => {
    expect(parseHash('#/tender/worldbank%3AP1')).toEqual({ name: 'tender', id: 'worldbank:P1' });
    expect(parseHash('#/?q=a')).toEqual({ name: 'list', query: 'q=a' });
    expect(parseHash('')).toEqual({ name: 'list', query: '' });
    expect(parseHash('#/scans').name).toBe('scans');
    expect(parseHash('#/tender/%E0%A4%A').name).toBe('list');
  });
  it('token storage survives a throwing localStorage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => getToken()).not.toThrow();
    spy.mockRestore();
    setToken('abc');
    expect(getToken()).toBe('abc');
    clearToken();
    expect(getToken()).toBeNull();
  });
});
