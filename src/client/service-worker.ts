/**
 * Registers the service worker, which browsers only allow over HTTPS or on localhost. A failure is not an error
 * the user can act on: the app works the same in a tab without it.
 */
export async function registerServiceWorker(nav: Navigator = navigator): Promise<boolean> {
  if (!("serviceWorker" in nav)) return false;
  try {
    await nav.serviceWorker.register("/sw.js", { scope: "/" });
    return true;
  } catch {
    return false;
  }
}
