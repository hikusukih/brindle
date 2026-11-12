const key = "brindle-token";

// localStorage, not sessionStorage: an installed app that is closed and reopened starts a new session, and asking
// for the token each time would make the phone unusable. Storage can throw (private windows, blocked storage); the
// app then asks again on each load.
export function getToken(): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(key, token);
    else window.localStorage.removeItem(key);
  } catch {}
}

/** A header, never a cookie, so a hostile page cannot ride the browser's state. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export const unauthorizedEvent = "brindle:unauthorized";
