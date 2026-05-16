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

export class ConflictLedger {
  constructor(dir) { this.path = join(dir, 'tracker-conflicts.jsonl'); }
  async record(entry) {
    const fd = openSync(this.path, 'a');
    try { writeSync(fd, JSON.stringify({ ts: Date.now(), ...entry }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  async all() {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }
}

export class Reconciler {
  constructor({ log, cache, dir, apply, maxAttempts = 5 }) {
    this.log = log; this.cache = cache; this.dir = dir;
    this.apply = apply; this.maxAttempts = maxAttempts;
    this.ledger = new ConflictLedger(dir);
  }
  async flush() {
    for (const op of await this.log.pending()) {
      try {
        const res = await this.apply(op);
        await this.cache.clearPending(op.code);
        if (res?.version) {
          const cur = await this.cache.get(op.code);
          if (cur) await this.cache.applyRemote(op.code, cur, { version: res.version });
        }
        await this.log.resolve(op.id);
      } catch (e) {
        if (e.casMismatch) {
          await this.ledger.record({ code: op.code, opId: op.id, kind: 'cas',
            baseVersion: op.baseVersion, remoteVersion: e.casMismatch.remoteVersion });
          await this.log.quarantine(op.id, 'cas');
          continue;
        }
        if (e.rateLimit) { await new Promise(r => setTimeout(r, Math.min(e.rateLimit.resetMs ?? 1000, 60000))); }
        const bumped = await this.log.bumpAttempt(op.id);
        if (bumped && bumped.attempts >= this.maxAttempts) {
          await this.ledger.record({ code: op.code, opId: op.id, kind: 'poison', error: String(e) });
          await this.log.quarantine(op.id, 'poison');
        }
        break; // FIFO: stop on first unresolved op so ordering is preserved
      }
    }
  }
}
