import { providerFor } from './factory.js';

export async function runTrackerCli(cwd, argv) {
  const sub = argv[0];
  const provider = await providerFor(cwd);
  if (sub === 'status') {
    const h = await provider.health();
    return [
      `tracker provider: ${h.provider}`,
      `canonical: ${h.canonical}`,
      `pendingOps: ${h.pendingOps}`,
      `conflicts: ${h.conflicts}`,
      `mixedSources: ${(h.mixedSources || []).join(', ') || '(none)'}`,
    ].join('\n');
  }
  if (sub === 'sync') {
    const r = await provider.sync();
    return `sync: drained ${r.drained}, quarantined ${r.quarantined ?? 0}, pending ${r.pending ?? 0}`;
  }
  return 'usage: compose tracker <status|sync>';
}
