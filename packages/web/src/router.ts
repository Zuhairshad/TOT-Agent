export type Route =
  | { name: 'list'; query: string }
  | { name: 'tender'; id: string }
  | { name: 'shortlist' }
  | { name: 'scans' }
  | { name: 'settings' };

/** Parse a location hash such as "#/tender/worldbank%3AP123" or "#/?q=helmet&page=2". */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = qi >= 0 ? raw.slice(qi + 1) : '';
  const parts = path.split('/').filter(Boolean);
  switch (parts[0]) {
    case 'tender':
      if (parts[1]) {
        try {
          return { name: 'tender', id: decodeURIComponent(parts.slice(1).join('/')) };
        } catch {
          return { name: 'list', query: '' };
        }
      }
      return { name: 'list', query: '' };
    case 'shortlist':
      return { name: 'shortlist' };
    case 'scans':
      return { name: 'scans' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'list', query };
  }
}
