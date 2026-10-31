import './style.css';
import { ApiClient } from './api/client';
import { clearToken, getToken, setToken } from './auth';
import type { AppContext } from './context';
import { exportTenders } from './pdf/download';
import { parseHash, type Route } from './router';
import { Selection, ShortlistStore } from './state';
import { clear, h, nextId, notice } from './ui/dom';
import { renderDetail } from './views/detail';
import { renderList } from './views/list';
import { renderScans } from './views/scans';
import { renderSettings } from './views/settings';
import { renderShortlist } from './views/shortlist';

const app = document.getElementById('app') as HTMLElement;
const main = h('main', { id: 'main', tabindex: '-1' });
const flashBox = h('div', { class: 'flash', 'aria-live': 'polite' });
let cleanup: (() => void) | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
/** True while the token prompt is showing; stops routes from drawing over it. */
let locked = false;

const api = new ApiClient({
  getToken,
  onUnauthorized: () =>
    showTokenPrompt('That access token was not accepted. Please enter it again.'),
});
const store = new ShortlistStore(api);
const ctx: AppContext = {
  api,
  store,
  selection: new Selection(),
  flash(message, kind = 'info') {
    clear(flashBox);
    flashBox.append(notice(kind, message));
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => clear(flashBox), kind === 'error' ? 12000 : 5000);
  },
  exportPdf: (ids) => exportTenders(ctx, ids),
};

const NAV: [string, string, Route['name']][] = [
  ['#/', 'Tenders', 'list'],
  ['#/shortlist', 'Shortlist', 'shortlist'],
  ['#/scans', 'Scans', 'scans'],
  ['#/settings', 'Search settings', 'settings'],
];

function shell(active: Route['name']): void {
  clear(app);
  app.append(
    h(
      'header',
      { class: 'topbar' },
      h('h1', {}, 'Tender monitor'),
      h(
        'nav',
        { 'aria-label': 'Main' },
        NAV.map(([href, label, name]) =>
          h('a', { href, 'aria-current': name === active ? 'page' : null }, label),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn linkish',
          onclick: () => {
            clearToken();
            showTokenPrompt('Signed out. Enter the access token to continue.');
          },
        },
        'Sign out',
      ),
    ),
    flashBox,
    main,
  );
}

function showTokenPrompt(message?: string): void {
  if (locked) return;
  locked = true;
  cleanup?.();
  cleanup = null;
  clear(app);
  const id = nextId('token');
  const input = h('input', { id, type: 'password', autocomplete: 'off', required: true });
  const form = h(
    'form',
    { class: 'token-form panel' },
    h('h1', {}, 'Tender monitor'),
    message ? notice('warn', message) : null,
    h('p', {}, 'Enter the access token (APP_TOKEN) for this app. It is kept in this browser only.'),
    h('div', { class: 'control' }, h('label', { for: id }, 'Access token'), input),
    h('button', { type: 'submit', class: 'btn primary' }, 'Continue'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    setToken(input.value.trim());
    locked = false;
    void start();
  });
  app.append(h('div', { class: 'center' }, form));
  input.focus();
}

function route(): void {
  if (locked) return;
  if (!getToken()) return showTokenPrompt();
  cleanup?.();
  const r = parseHash(location.hash);
  clear(main);
  shell(r.name);
  switch (r.name) {
    case 'list':
      cleanup = renderList(main, ctx, r.query);
      break;
    case 'tender':
      cleanup = renderDetail(main, ctx, r.id);
      break;
    case 'shortlist':
      cleanup = renderShortlist(main, ctx);
      break;
    case 'scans':
      cleanup = renderScans(main, ctx);
      break;
    case 'settings':
      cleanup = renderSettings(main, ctx);
      break;
  }
  document.title = `${NAV.find((n) => n[2] === r.name)?.[1] ?? 'Tender'} - Tender monitor`;
  window.scrollTo(0, 0);
}

async function start(): Promise<void> {
  if (!getToken()) return showTokenPrompt();
  try {
    await store.load();
  } catch {
    /* 401 shows the prompt via onUnauthorized; other errors: the star state is filled in per list */
  }
  route();
}

window.addEventListener('hashchange', route);
void start();
