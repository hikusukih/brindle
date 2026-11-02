const key = "brindle-token";

// sessionStorage can throw (private windows, blocked storage); the app then asks again on each load.
export function getToken(): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) window.sessionStorage.setItem(key, token);
    else window.sessionStorage.removeItem(key);
  } catch {}
}

/** A header, never a cookie, so a hostile page cannot ride the browser's state. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export const unauthorizedEvent = "brindle:unauthorized";
