import { providerFor } from './factory.js';

export async function runTrackerCli(cwd, argv) {
  const sub = argv[0];

  // Guard unknown/missing subcommand BEFORE touching providerFor (no I/O on bad input).
  if (sub !== 'status' && sub !== 'sync') {
    return { output: 'usage: compose tracker <status|sync>', exitCode: 1 };
  }

  const provider = await providerFor(cwd);

  if (sub === 'status') {
    const h = await provider.health();
    const output = [
      `tracker provider: ${h.provider}`,
      `canonical: ${h.canonical}`,
      `pendingOps: ${h.pendingOps}`,
      `conflicts: ${h.conflicts}`,
      `mixedSources: ${(h.mixedSources || []).join(', ') || '(none)'}`,
    ].join('\n');
    return { output, exitCode: 0 };
  }

  // sub === 'sync'
  const r = await provider.sync();
  return {
    output: `sync: drained ${r.drained}, quarantined ${r.quarantined ?? 0}, pending ${r.pending ?? 0}`,
    exitCode: 0,
  };
}
