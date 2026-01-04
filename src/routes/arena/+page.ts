import { browser } from '$app/environment';
import { resolve } from '$app/paths';

export const ssr = false;

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export const load = () => {
  // GitHub Pages is static and publicly accessible. Keep the arena runner/dev tools local-only.
  // The Playwright runner uses localhost/127.0.0.1, so it remains unaffected.
  if (browser && !isLocalhost(window.location.hostname)) {
    // On GitHub Pages (static), the only way to show the host's 404 page is to navigate
    // to a URL that doesn't exist (server-side 404). Do a full reload.
    window.location.replace(resolve('/__404__'));
    return {};
  }

  return {};
};

