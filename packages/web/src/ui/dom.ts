/** Tiny DOM helper: h('div', {class: 'x', onclick}, 'text', child). No framework, no innerHTML. */
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
export type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'value' && 'value' in el) {
      (el as unknown as HTMLInputElement).value = String(v);
    } else if (k === 'checked' && 'checked' in el) {
      (el as unknown as HTMLInputElement).checked = v === true;
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let uid = 0;
export const nextId = (prefix: string) => `${prefix}-${++uid}`;

/** A visually obvious, screen-reader friendly message box. */
export function notice(kind: 'info' | 'warn' | 'error', ...children: Child[]): HTMLElement {
  return h(
    'div',
    { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    ...children,
  );
}

/** Trigger a browser download of bytes. */
export function downloadBytes(bytes: Uint8Array, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Only http(s) links are ever made clickable: record URLs come from scraped pages. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export function link(url: string, text?: string): HTMLElement {
  const href = safeHref(url);
  return href
    ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text ?? url)
    : h('span', {}, text ?? url);
}
