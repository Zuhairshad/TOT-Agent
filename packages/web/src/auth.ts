const KEY = 'tender-monitor.token';

/** localStorage can throw (private mode, blocked storage): never let that break the app. */
export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return memoryToken;
  }
}

let memoryToken: string | null = null;

export function setToken(token: string): void {
  memoryToken = token;
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* kept in memory for this tab only */
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
