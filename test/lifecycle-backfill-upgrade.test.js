import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBackfillUpgrade, resourceId, _testOnly_setGuardClient, _testOnly_resetGuardCache,
} from '../server/lifecycle-guard.js';

function client({ policy, applyUpgrade }) {
  return {
    register: async () => ({ status: 'registered' }),
    transition: async () => ({ status: 'applied' }),
    policy: async () => policy,
    applyUpgrade,
  };
}

test('applyBackfillUpgrade reads stored policy and sends an absolute descriptor file path', async () => {
  _testOnly_resetGuardCache();
  let received;
  _testOnly_setGuardClient(client({
    policy: { status: 'ok', checksum: 'a'.repeat(64) },
    applyUpgrade: async (args) => { received = args; return { status: 'applied', ledger_ref: 'ledger-1', checksum: 'b'.repeat(64) }; },
  }));
  const result = await applyBackfillUpgrade({ featureCode: 'F1', workspaceRoot: '/tmp/workspace', mode: 'build' });
  assert.deepEqual(result, { ok: true, status: 'applied', ledgerRef: 'ledger-1', checksum: 'b'.repeat(64) });
  assert.deepEqual(received, {
    resourceId: resourceId('F1', '/tmp/workspace', 'build'),
    descriptorId: 'backfill-build-aaaaaaaaaaaa',
    descriptorsPath: '/tmp/workspace/.compose/guard-upgrades.json',
  });
});

test('applyBackfillUpgrade refuses every raw error envelope with descriptor remediation', async () => {
  _testOnly_resetGuardCache();
  _testOnly_setGuardClient(client({
    policy: { status: 'ok', checksum: 'a'.repeat(64) },
    applyUpgrade: async () => ({ status: 'error', error_type: 'upgrade_descriptor_unavailable', message: 'not signed' }),
  }));
  const result = await applyBackfillUpgrade({ featureCode: 'F1', workspaceRoot: '/tmp/workspace', mode: 'build' });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /compose guard descriptors/);
  assert.match(result.reasons.join('\n'), /re-sign/);
  assert.equal(result.error.code, 'upgrade_descriptor_unavailable');
});
