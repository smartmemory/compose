import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpLog } from '../../lib/tracker/sync-engine.js';

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
