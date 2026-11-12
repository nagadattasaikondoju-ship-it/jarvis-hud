// Installable app support: service worker, install prompt and the taskbar badge.
import { useEffect, useState } from 'react';

let deferred = null;
const subs = new Set();
const emit = () => subs.forEach((f) => f());

export function initPwa() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own INSTALL button instead of the mini-infobar
    deferred = e;
    emit();
  });
  window.addEventListener('appinstalled', () => { deferred = null; emit(); });
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is optional */ });
    });
  }
}

export const isStandalone = () => {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  } catch {
    return false;
  }
};

/** { canInstall, installed, install() } */
export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => subs.delete(f);
  }, []);
  return {
    canInstall: !!deferred && !isStandalone(),
    installed: isStandalone(),
    async install() {
      if (!deferred) return false;
      const e = deferred;
      deferred = null;
      emit();
      e.prompt();
      const r = await e.userChoice.catch(() => null);
      return r?.outcome === 'accepted';
    },
  };
}

/** Number on the app's taskbar / dock icon (installed app only; ignored elsewhere). */
export function setBadge(n) {
  try {
    if (n > 0) navigator.setAppBadge?.(n)?.catch?.(() => {});
    else navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch { /* unsupported */ }
}
