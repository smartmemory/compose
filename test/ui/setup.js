// No extra matchers; tests use plain DOM assertions + @testing-library/react's
// built-in queries. testing-library registers its cleanup hook with vitest
// automatically via the globals setup in vitest.config.js.

// ---------------------------------------------------------------------------
// COMP-UITEST-ISOLATION-1 — localStorage safety net.
//
// Under heavy parallel worker setup, the `localStorage` global Vitest bridges
// from jsdom into the test scope was intermittently absent — observed as
// "TypeError: Cannot read properties of undefined (reading 'clear')" at the top
// of `beforeEach` hooks that call `localStorage.clear()` (mobile-app /
// mobile-pair / mobile-remote-auth / agent-stream-remote-mode). A single flaky
// run took down ~140 tests (and cascaded into `wsMod` undefined where the
// aborted beforeEach never reached its `await import(...)`), yet every retry
// passed. This is an environment-bridging race under contention, NOT a jsdom
// opaque-origin issue (Vitest already boots jsdom on a concrete origin).
//
// Defense: if `localStorage` is missing OR inaccessible (an opaque-origin
// SecurityError is handled too, for robustness) when a file is set up, install
// a minimal in-memory implementation so a transient glitch can never crash a
// whole file. On the normal path this is a no-op — the real storage is kept.
// ---------------------------------------------------------------------------
function localStorageUsable() {
  try {
    const ls = globalThis.localStorage;
    if (ls == null) return false;
    ls.getItem('__compose_ls_probe__'); // surfaces a SecurityError if origin is opaque
    return true;
  } catch {
    return false;
  }
}

function createMemoryStorage() {
  const store = new Map();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      const k = String(key);
      return store.has(k) ? store.get(k) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
  };
}

if (!localStorageUsable()) {
  const mem = createMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
  if (typeof globalThis.window !== 'undefined') {
    try {
      Object.defineProperty(globalThis.window, 'localStorage', { value: mem, configurable: true, writable: true });
    } catch {
      /* window.localStorage may be a non-configurable getter — globalThis copy is enough */
    }
  }
}
