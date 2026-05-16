import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const OPLOG = 'tracker-oplog.jsonl';
const QUAR  = 'tracker-quarantine.jsonl';

export class OpLog {
  constructor(dataDir) {
    this.dir = dataDir;
    this.path = join(dataDir, OPLOG);
    this.quarPath = join(dataDir, QUAR);
  }
  _all() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }
  async pending() { return this._all().filter(o => o.state === 'pending'); }
  async quarantined() {
    if (!existsSync(this.quarPath)) return [];
    return readFileSync(this.quarPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }
  async append(op) {
    if (op.idempotencyKey) {
      const dup = this._all().find(o => o.idempotencyKey === op.idempotencyKey);
      if (dup) return dup;
    }
    const { id: _i, ts: _t, state: _s, attempts: _a, ...safe } = op;
    const rec = { ...safe, id: randomUUID(), ts: Date.now(), state: 'pending', attempts: 0 };
    const fd = openSync(this.path, 'a');
    try { writeSync(fd, JSON.stringify(rec) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    return rec;
  }
  _rewrite(records) {
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
    renameSync(tmp, this.path);
  }
  async resolve(id) { this._rewrite(this._all().filter(o => o.id !== id)); }
  async bumpAttempt(id) {
    const all = this._all();
    const o = all.find(x => x.id === id); if (o) o.attempts += 1;
    this._rewrite(all);
    return o;
  }
  async quarantine(id, reason) {
    const all = this._all();
    const o = all.find(x => x.id === id);
    if (o) {
      const fd = openSync(this.quarPath, 'a');
      try { writeSync(fd, JSON.stringify({ ...o, state: 'quarantined', reason }) + '\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
      this._rewrite(all.filter(x => x.id !== id));
    }
  }
}

export class Cache {
  constructor(dataDir) {
    this.dir = join(dataDir, 'tracker-cache');
    mkdirSync(this.dir, { recursive: true });
    this.path = join(this.dir, 'features.json');
  }
  _load() { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {}; }
  _save(s) { const t = this.path + '.tmp'; writeFileSync(t, JSON.stringify(s, null, 2)); renameSync(t, this.path); }
  async get(code) { return this._load()[code]?.value ?? null; }
  async version(code) { return this._load()[code]?.version ?? null; }
  async put(code, value, { version, pending = false } = {}) {
    const s = this._load();
    s[code] = { value, version: version ?? s[code]?.version ?? null,
                pending: pending || s[code]?.pending || false };
    this._save(s);
  }
  async markPending(code) { const s = this._load(); if (s[code]) { s[code].pending = true; this._save(s); } }
  async clearPending(code) { const s = this._load(); if (s[code]) { s[code].pending = false; this._save(s); } }
  async applyRemote(code, value, { version }) {
    const s = this._load();
    if (s[code]?.pending) return; // shadow: never roll back an entry with a pending op
    s[code] = { value, version, pending: false };
    this._save(s);
  }
}
