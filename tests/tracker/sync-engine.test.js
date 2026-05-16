import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpLog, Cache, Reconciler, ConflictLedger } from '../../lib/tracker/sync-engine.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'ctp-oplog-')); }

describe('OpLog', () => {
  it('append is durable and FIFO', async () => {
    const d = tmp();
    try {
      const log = new OpLog(d);
      await log.append({ op: 'setStatus', code: 'A', payload: { to: 'IN_PROGRESS' } });
      await log.append({ op: 'setStatus', code: 'B', payload: { to: 'COMPLETE' } });
      const log2 = new OpLog(d);
      const pending = await log2.pending();
      expect(pending.map(o => o.code)).toEqual(['A', 'B']);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('idempotencyKey dedupe: re-append returns prior op id, no duplicate', async () => {
    const d = tmp();
    try {
      const log = new OpLog(d);
      const a = await log.append({ op: 'recordCompletion', code: 'A', idempotencyKey: 'k1', payload: {} });
      const b = await log.append({ op: 'recordCompletion', code: 'A', idempotencyKey: 'k1', payload: {} });
      expect(b.id).toBe(a.id);
      expect((await log.pending()).length).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('engine-managed fields are authoritative (caller cannot clobber id/state/attempts/ts)', async () => {
    const d = tmp();
    try {
      const log = new OpLog(d);
      const r = await log.append({ op: 'setStatus', code: 'A', id: 'evil', state: 'resolved', attempts: 99, ts: 1, payload: {} });
      expect(r.id).not.toBe('evil');
      expect(r.state).toBe('pending');
      expect(r.attempts).toBe(0);
      expect(typeof r.ts).toBe('number');
      expect(r.ts).not.toBe(1);
      expect(r.code).toBe('A');
      const pending = await log.pending();
      expect(pending.length).toBe(1);
      expect(pending[0].state).toBe('pending');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('resolve removes an op; quarantine moves it aside', async () => {
    const d = tmp();
    try {
      const log = new OpLog(d);
      const op = await log.append({ op: 'setStatus', code: 'A', payload: {} });
      await log.resolve(op.id);
      expect((await log.pending()).length).toBe(0);
      const op2 = await log.append({ op: 'setStatus', code: 'B', payload: {} });
      await log.quarantine(op2.id, 'conflict');
      expect((await log.pending()).length).toBe(0);
      expect((await log.quarantined()).length).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('Cache shadowing + CAS', () => {
  it('getFeature returns post-op value while an op is pending (no rollback)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctp-cache-'));
    try {
      const c = new Cache(d);
      await c.put('A', { code: 'A', status: 'PLANNED' }, { version: 'v1' });
      await c.markPending('A');
      await c.put('A', { code: 'A', status: 'IN_PROGRESS' }, { version: 'v1', pending: true });
      await c.applyRemote('A', { code: 'A', status: 'PLANNED' }, { version: 'v2' });
      expect((await c.get('A')).status).toBe('IN_PROGRESS');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('applyRemote updates entries with no pending op', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctp-cache2-'));
    try {
      const c = new Cache(d);
      await c.put('B', { code: 'B', status: 'PLANNED' }, { version: 'v1' });
      await c.applyRemote('B', { code: 'B', status: 'COMPLETE' }, { version: 'v9' });
      expect((await c.get('B')).status).toBe('COMPLETE');
      expect(await c.version('B')).toBe('v9');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('Reconciler', () => {
  it('flushes pending ops in FIFO and resolves them', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctp-rec-'));
    try {
      const log = new OpLog(d); const cache = new Cache(d);
      await log.append({ op: 'setStatus', code: 'A', payload: { to: 'IN_PROGRESS' }, baseVersion: 'v1' });
      const applied = [];
      const apply = async (op) => { applied.push(op.code); return { version: 'v2' }; };
      const r = new Reconciler({ log, cache, dir: d, apply });
      await r.flush();
      expect(applied).toEqual(['A']);
      expect((await log.pending()).length).toBe(0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('CAS mismatch quarantines the op and writes a conflict ledger entry', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ctp-rec2-'));
    try {
      const log = new OpLog(d); const cache = new Cache(d);
      const op = await log.append({ op: 'setStatus', code: 'A', payload: { to: 'X' }, baseVersion: 'v1' });
      const apply = async () => { const e = new Error('stale'); e.casMismatch = { remoteVersion: 'v7' }; throw e; };
      const r = new Reconciler({ log, cache, dir: d, apply });
      await r.flush();
      expect((await log.quarantined()).map(o => o.id)).toContain(op.id);
      expect((await new ConflictLedger(d).all()).length).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
