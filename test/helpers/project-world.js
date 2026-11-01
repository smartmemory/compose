/**
 * project-world.js — a throwaway tree of Compose roots for COMP-COCKPIT-PROJECT-MODEL-1 tests. Never the real roots.
 *
 *   host/                       projects.roots = [sm, forge, trader]
 *   sm/                         project smartmemory, lanes main + hub, a store; sm/cadence -> ../forge/cadence (symlink)
 *   forge/                      project forge: lanes compose+stratum (ops lane forge), cadence, choir (ops lane codegen)
 *     store: ROOT-1 (root-only), SHARED-1 (also in compose), ENG-5 (also in compose and stratum), track "compose"
 *     compose/  store: SHARED-1, ENG-5, COMP-2; edge SHARED-1 -informs-> COMP-2
 *     stratum/  store: ENG-5; docs/features/ENG-5/design.md on disk
 *     cadence/  store: CAD-1
 *     choir/    no .compose (no store)
 *   trader/                     project trader, lane trader, no store
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const put = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};

export const item = (id, code, extra = {}) => ({
  id, type: 'feature', title: code, status: 'planned', phase: 'planning', files: [], lifecycle: { featureCode: code }, ...extra,
});

export function makeWorld() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'project-world-')));
  const d = {
    base,
    host: join(base, 'host'), sm: join(base, 'sm'), forge: join(base, 'forge'), trader: join(base, 'trader'),
  };
  const cfg = (dir, value) => put(join(dir, '.compose', 'compose.json'), value);
  const store = (dir, state) => put(join(dir, '.compose', 'data', 'vision-state.json'), { items: [], connections: [], gates: [], ...state });
  cfg(d.host, { version: 2, projects: { roots: [d.sm, d.forge, d.trader] } });
  cfg(d.sm, { version: 2, project: { name: 'smartmemory', label: 'SmartMemory', lanes: [{ id: 'main' }, { id: 'hub' }], modules: [] } });
  store(d.sm, { items: [item('s1', 'SM-1')] });
  cfg(d.forge, {
    version: 2,
    project: {
      name: 'forge', label: 'Forge',
      lanes: [
        { id: 'compose', opsLane: 'forge', module: 'compose' }, { id: 'stratum', opsLane: 'forge', module: 'stratum' },
        { id: 'cadence', module: 'cadence' }, { id: 'choir', opsLane: 'codegen', module: 'choir' },
      ],
      modules: [{ name: 'compose', path: 'compose' }, { name: 'stratum', path: 'stratum' }, { name: 'cadence', path: 'cadence' }, { name: 'choir', path: 'choir' }],
    },
  });
  store(d.forge, {
    items: [item('r1', 'ROOT-1'), item('r2', 'SHARED-1'), item('r3', 'ENG-5'), { id: 't1', type: 'track', title: 'compose', status: 'in_progress' }],
    connections: [{ id: 'rc1', fromId: 'r1', toId: 'r2', type: 'informs' }],
  });
  const compose = join(d.forge, 'compose');
  cfg(compose, { version: 2, capabilities: { lifecycle: true } });
  store(compose, {
    items: [item('c1', 'SHARED-1', { status: 'complete', files: ['docs/features/SHARED-1/design.md'] }), item('c2', 'ENG-5'), item('c3', 'COMP-2')],
    connections: [{ id: 'cc1', fromId: 'c1', toId: 'c3', type: 'informs' }, { id: 'cc2', fromId: 'c2', toId: 'c3', type: 'blocks' }],
  });
  put(join(compose, 'docs', 'features', 'SHARED-1', 'design.md'), '# SHARED-1 (compose copy)\n');
  const stratum = join(d.forge, 'stratum');
  cfg(stratum, { version: 2 });
  store(stratum, { items: [item('x1', 'ENG-5', { files: ['docs/features/ENG-5/design.md'] })] });
  put(join(stratum, 'docs', 'features', 'ENG-5', 'design.md'), '# ENG-5 (stratum)\n');
  const cadence = join(d.forge, 'cadence');
  cfg(cadence, { version: 2 });
  store(cadence, { items: [item('k1', 'CAD-1')] });
  mkdirSync(join(d.forge, 'choir', 'docs', 'features'), { recursive: true });
  symlinkSync('../forge/cadence', join(d.sm, 'cadence'));
  cfg(d.trader, { version: 2, project: { name: 'trader', label: 'Trader', lanes: [{ id: 'trader' }], modules: [] } });
  return { ...d, compose, stratum, cadence, choir: join(d.forge, 'choir'), cfg, store, put, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
