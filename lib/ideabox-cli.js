/**
 * lib/ideabox-cli.js — `compose ideabox …`, writing to the record store.
 *
 * COMP-PLAN-IDEA-UNIFY S3b-1 (D18).
 *
 * Lifted out of a ~300-line inline `else if` block in `bin/compose.js` with no
 * named symbol, in a 3,400-line file. The move is not cosmetic: it is what lets
 * the cutover be driven in-process by a test instead of only through a
 * subprocess, and the cutover is the part that needed testing most.
 *
 * WHAT CHANGED UNDER THE COMMANDS
 * -------------------------------
 * Every mutation used to be read-markdown → mutate → write-markdown. It is now
 * read-record → mutate-record → re-render the markdown. The file is output.
 *
 * Behaviour is otherwise preserved deliberately, including output wording, exit
 * codes and flag parsing, because a cutover that also redesigns the commands
 * cannot be reviewed: any difference becomes ambiguous between "intended" and
 * "regression". One exception is documented at `normalizeTags`.
 *
 * TWO INVARIANTS EVERY MUTATING PATH KEEPS
 * ----------------------------------------
 *  1. `ensureIdeaboxMigrated` runs FIRST. Without it an upgraded project with a
 *     populated markdown ideabox and an empty store would have its ideas
 *     replaced by whatever the user typed. See `fluid/ideabox-migrate.js`.
 *  2. The projection is rewritten after the record is written, never before. If
 *     the render throws — which it does, loudly, on an idea pointing at a
 *     cluster that does not exist — the record is already durable and
 *     `compose ideabox render` completes the job. Ordering it the other way
 *     would leave a file describing a state that was never stored.
 */

import { existsSync } from 'node:fs';

import { fluidProviderFor } from './fluid/factory.js';
import { ensureIdeaboxMigrated } from './fluid/ideabox-migrate.js';
import { writeIdeaboxProjection } from './fluid/render-ideabox.js';
import { KIND } from './fluid/provider.js';
import { resolveIdeaboxPath } from './project-paths.js';

const USAGE = [
  'Usage: compose ideabox <subcommand>',
  '',
  'Subcommands:',
  '  add "<title>"                Add a new idea',
  '  list                         List all ideas',
  '  promote <ID>                 Mark idea as PROMOTED (creates feature folder)',
  '  kill <ID> "<reason>"         Move idea to Killed Ideas',
  '  pri <ID> <P0|P1|P2>          Set priority',
  '  discuss <ID> "<comment>"     Add a discussion comment',
  '  triage [--lens <name>]       Walk untriaged ideas and assign priorities',
  '  render                       Rewrite the ideabox file from the records',
];

const PRIORITIES = ['P0', 'P1', 'P2'];
const flagValue = (args, name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

/**
 * Tags are stored bare.
 *
 * The old CLI force-prefixed `--tags` with `#`, which never matched the file:
 * every idea on disk uses bare words, and the projection's own convention line
 * now documents them that way. Preserving the prefix would have the generated
 * file contradict the convention it prints two screens above. No existing record
 * uses `#`, so normalising costs nothing. The PARSER still accepts `#`-prefixed
 * tags verbatim, so hand-written files that use them keep working.
 */
const normalizeTags = (raw) =>
  (raw ? raw.split(',') : [])
    .map((t) => t.trim().replace(/^#/, ''))
    .filter(Boolean);

/** Status enum → the legacy display label the list output has always used. */
const displayStatus = (record) => {
  if (record.status === 'promoted') return 'PROMOTED';
  if (record.status === 'discussing') return 'DISCUSSING';
  return 'NEW';
};

const displayPriority = (record) => record.priority ?? '—';

/** Find by handle, case-insensitively, the way the old CLI accepted `idea-3`. */
async function findIdea(provider, id) {
  const wanted = String(id ?? '').toUpperCase();
  const records = await provider.listRecords({ kind: KIND.IDEA });
  return records.find((r) => r.handle.toUpperCase() === wanted) ?? null;
}

/**
 * Resolve a `--cluster` argument to a cluster HANDLE.
 *
 * The flag has always taken free text. The renderer matches members by handle,
 * so storing the raw name puts the idea in neither its cluster nor the
 * unclustered bucket: it disappears from the file while its record sits on disk.
 * A name is therefore resolved to an existing cluster, or a cluster is created
 * for it deliberately. A handle is accepted as-is but must exist.
 */
async function resolveCluster(provider, name) {
  if (!name) return null;
  const clusters = await provider.listRecords({ kind: KIND.CLUSTER });

  const byHandle = clusters.find((c) => c.handle.toUpperCase() === name.toUpperCase());
  if (byHandle) return byHandle.handle;

  const byTitle = clusters.filter((c) => c.title.toLowerCase() === name.toLowerCase());
  if (byTitle.length === 1) return byTitle[0].handle;
  if (byTitle.length > 1) {
    throw new Error(
      `compose: "${name}" matches ${byTitle.length} clusters (${byTitle.map((c) => c.handle).join(', ')}). ` +
      `Pass the handle instead.`
    );
  }

  const created = await provider.createRecord({ kind: KIND.CLUSTER, title: name });
  console.log(`Created cluster ${created.handle}: ${name}`);
  return created.handle;
}

/**
 * @param {string} cwd project root
 * @param {string[]} args argv after `ideabox`
 * @param {object} [opts]
 * @param {object} [opts.config] already-loaded `.compose/compose.json`
 * @returns {Promise<number>} process exit code
 */
export async function runIdeaboxCommand(cwd, args, opts = {}) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    for (const line of USAGE) console.log(line);
    return 0;
  }

  const ideaboxPath = resolveIdeaboxPath(cwd);
  const provider = await fluidProviderFor(cwd);

  // Read-only paths still migrate: `list` on an upgraded project must show the
  // user's real ideas, not an empty store. It is the same import either way, and
  // running it lazily on first read rather than first write means the upgrade
  // happens at the least destructive moment available.
  const render = () => writeIdeaboxProjection(provider, ideaboxPath);
  const gate = () => ensureIdeaboxMigrated(provider, ideaboxPath);

  switch (sub) {
    case 'add': {
      const title = args.slice(1).find((a) => !a.startsWith('-')) || args[1];
      if (!title) {
        console.error('Usage: compose ideabox add "<title>" [--source "..."] [--desc "..."] [--cluster "..."]');
        return 1;
      }
      await gate();
      const cluster = await resolveCluster(provider, flagValue(args, '--cluster'));
      const record = await provider.createRecord({
        kind: KIND.IDEA,
        title,
        body: flagValue(args, '--desc') ?? '',
        source: flagValue(args, '--source') ?? '',
        tags: normalizeTags(flagValue(args, '--tags')),
        cluster,
        provenance: { origin: 'cli:ideabox' },
      });
      await render();
      console.log(`Added ${record.handle}: ${record.title}`);
      return 0;
    }

    case 'list': {
      if (!existsSync(ideaboxPath) && !(await provider.listRecords({ kind: KIND.IDEA })).length) {
        console.log('No ideabox found. Run: compose ideabox add "<title>"');
        return 0;
      }
      await gate();
      const ideas = await provider.listRecords({ kind: KIND.IDEA });
      if (ideas.length === 0) {
        console.log('No ideas yet.');
        return 0;
      }

      const live = ideas.filter((i) => i.status !== 'killed');
      const killed = ideas.filter((i) => i.status === 'killed');
      const order = { P0: 0, P1: 1, P2: 2, '—': 3 };

      for (const status of ['NEW', 'DISCUSSING', 'PROMOTED']) {
        const group = live.filter((i) => displayStatus(i) === status);
        if (!group.length) continue;
        group.sort((a, b) => (order[displayPriority(a)] ?? 3) - (order[displayPriority(b)] ?? 3));
        console.log(`\n[${status}]`);
        for (const idea of group) {
          const pri = displayPriority(idea) !== '—' ? ` [${displayPriority(idea)}]` : '';
          const tags = idea.tags.length ? ` ${idea.tags.join(' ')}` : '';
          console.log(`  ${idea.handle}${pri}  ${idea.title}${tags}`);
        }
      }

      if (killed.length) {
        console.log(`\n[KILLED] (${killed.length})`);
        for (const idea of killed) {
          console.log(`  ${idea.handle}  ${idea.title}  — ${idea.killed?.reason ?? ''}`);
        }
      }
      return 0;
    }

    case 'promote': {
      const id = args[1];
      if (!id) {
        console.error('Usage: compose ideabox promote <ID> [<FEATURE-CODE>]');
        return 1;
      }
      await gate();
      const idea = await findIdea(provider, id);
      if (!idea) {
        console.error(`Idea not found: ${id}`);
        return 1;
      }

      let code = args[2] || '';
      if (!code) {
        const slug = idea.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/-+$/, '');
        code = `${idea.handle}-${slug}`.toUpperCase();
      }

      const { resolveFeaturesPathFromConfig } = await import('./project-paths.js');
      const featuresBase = resolveFeaturesPathFromConfig(cwd, opts.config ?? {});
      const { join } = await import('node:path');
      if (!existsSync(join(featuresBase, code))) {
        // COMP-MCP-VALIDATE-1: route through the validated writer.
        const { writeFeature } = await import('./feature-json.js');
        writeFeature(cwd, {
          code,
          description: idea.title,
          status: 'PLANNED',
          promotedFrom: idea.handle,
          createdAt: new Date().toISOString(),
        }, featuresBase);
        console.log(`Created feature folder: ${join(featuresBase, code)}/`);
      }

      // The promotion is a real link now, not a formatted status string. S4
      // wants this edge in the graph; recording it as data rather than prose is
      // what makes that possible without re-parsing the label.
      await provider.updateRecord(idea.handle, {
        status: 'promoted',
        links: [...idea.links.filter((l) => l.type !== 'promoted_to'), { type: 'promoted_to', target: code }],
      });
      await render();
      console.log(`Promoted ${idea.handle} → ${code}`);
      return 0;
    }

    case 'kill': {
      const id = args[1];
      const reason = args[2] || '';
      if (!id) {
        console.error('Usage: compose ideabox kill <ID> "<reason>"');
        return 1;
      }
      await gate();
      const idea = await findIdea(provider, id);
      if (!idea) {
        console.error(`Idea not found: ${id}`);
        return 1;
      }
      await provider.updateRecord(idea.handle, {
        status: 'killed',
        killed: { at: new Date().toISOString(), reason: reason || '(no reason given)' },
      });
      await render();
      console.log(`Killed ${idea.handle}: ${reason}`);
      return 0;
    }

    case 'pri': {
      const id = args[1];
      const priority = args[2];
      if (!id || !priority) {
        console.error('Usage: compose ideabox pri <ID> <P0|P1|P2>');
        return 1;
      }
      if (!PRIORITIES.includes(priority.toUpperCase()) && priority !== '—') {
        console.error(`Invalid priority: ${priority}. Use P0, P1, P2 or —`);
        return 1;
      }
      await gate();
      const idea = await findIdea(provider, id);
      if (!idea) {
        console.error(`Idea not found: ${id}`);
        return 1;
      }
      await provider.updateRecord(idea.handle, {
        priority: priority === '—' ? null : priority.toUpperCase(),
      });
      await render();
      console.log(`Set ${idea.handle} priority → ${priority}`);
      return 0;
    }

    case 'discuss': {
      const id = args[1];
      const comment = args[2];
      if (!id || !comment) {
        console.error('Usage: compose ideabox discuss <ID> "<comment>"');
        return 1;
      }
      await gate();
      const idea = await findIdea(provider, id);
      if (!idea) {
        console.error(`Idea not found: ${id}`);
        return 1;
      }
      await provider.appendDiscussion(idea.handle, { text: comment, author: 'human' });
      await render();
      console.log(`[${new Date().toISOString().slice(0, 10)}] human: ${comment}`);
      return 0;
    }

    case 'triage': {
      const lensName = flagValue(args, '--lens');
      await gate();
      const ideas = await provider.listRecords({ kind: KIND.IDEA });
      const untriaged = ideas.filter((i) => !i.priority && i.status === 'new');
      if (!untriaged.length) {
        console.log('No untriaged ideas.');
        return 0;
      }

      if (lensName) {
        const { loadLens } = await import('./ideabox.js');
        if (!loadLens(cwd, lensName)) {
          console.warn(`Lens not found: docs/product/ideabox-priority-${lensName}.md`);
        } else {
          console.log(`Using lens: ${lensName}`);
        }
      }

      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

      let changed = false;
      try {
        for (const idea of untriaged) {
          console.log(`\n${idea.handle}: ${idea.title}`);
          if (idea.body) console.log(`  ${idea.body.slice(0, 120)}`);
          if (lensName) console.log(`  [lens: ${lensName}]`);
          const answer = (await ask('  Priority [P0/P1/P2/skip]: ')).trim().toUpperCase();
          if (PRIORITIES.includes(answer)) {
            await provider.updateRecord(idea.handle, { priority: answer });
            changed = true;
            console.log(`  Set ${idea.handle} → ${answer}`);
          } else {
            console.log('  Skipped');
          }
        }
      } finally {
        rl.close();
      }

      if (changed) {
        await render();
        console.log('\nSaved.');
      }
      return 0;
    }

    case 'render': {
      // The repair path. Every mutation writes the record before the projection,
      // so a failed render leaves durable canon and a stale file; this is how the
      // file catches up without touching a record. Also the fix for a projection
      // that was interrupted, and the way back from any hand edit.
      await gate();
      await render();
      console.log(`Rendered ${ideaboxPath}`);
      return 0;
    }

    default:
      console.error(`Unknown ideabox subcommand: ${sub}`);
      console.error('Run: compose ideabox --help');
      return 1;
  }
}
