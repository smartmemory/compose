// compose/server/coalescing-buffer.js

export class CoalescingBuffer {
  #modes = new Map();
  #pending = new Map();
  #timer = null;
  #flushFn;

  constructor(flushFn, { intervalMs = 16 } = {}) {
    this.#flushFn = flushFn;
    this.#timer = setInterval(() => this.#flush(), intervalMs);
  }

  register(key, mode) {
    if (mode !== 'latest-wins' && mode !== 'append') {
      throw new Error(`Unknown mode: ${mode}`);
    }
    this.#modes.set(key, mode);
  }

  put(key, value) {
    const mode = this.#modes.get(key);
    if (!mode) throw new Error(`Key not registered: ${key}`);
    if (mode === 'latest-wins') {
      this.#pending.set(key, value);
    } else {
      const arr = this.#pending.get(key) ?? [];
      arr.push(value);
      this.#pending.set(key, arr);
    }
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #flush() {
    if (this.#pending.size === 0) return;
    const data = Object.fromEntries(this.#pending);
    this.#pending.clear();
    this.#flushFn(data);
  }
}
