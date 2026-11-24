'use strict';
// OneTab Proof03: temporary prepaint guard for Nestrill's original menu.
// Keep this tiny: it runs at document_start before Nestrill builds its DOM.
(() => {
  if (location.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(location.hostname) ||
      location.port !== '8767') return;
  const root = document.documentElement;
  if (!root) return;  // Fail open if the DOM root is unexpectedly unavailable.

  // Prevent Nestrill's own sidebar from flashing while the saved mode is read.
  // The stylesheet is preloaded at document_start in manifest.json.
  root.classList.add('nx1-boot-guard');
  let settled = false;
  let watchdog;
  function release(compact) {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    // A later content.js action (e.g. Restore Native) takes precedence.
    if (!root.classList.contains('nx1-boot-guard')) return;
    if (compact === true) root.classList.add('nx4-hide-native-menu');
    root.classList.remove('nx1-boot-guard');
  }
  // Fail open: never leave the genuine menu hidden indefinitely if the
  // extension's service worker cannot answer.
  watchdog = setTimeout(() => release(false), 3000);
  try {
    chrome.runtime.sendMessage({type:'NX4_STATUS_FOR_TAB'})
      .then(r => release(r?.ok === true && r.compact === true))
      .catch(() => release(false));
  } catch (_) { release(false); }
})();
