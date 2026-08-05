/**
 * lib/ideabox-cli.js — `compose ideabox …`, writing to the record store.
 *
 * COMP-PLAN-IDEA-UNIFY S3b-1 (D18), rebased onto the shared operations in S3b-2
 * (D20).
 *
 * Lifted out of a ~300-line inline `else if` block in `bin/compose.js` with no
 * named symbol, in a 3,400-line file. The move is not cosmetic: it is what lets
 * the cutover be driven in-process by a test instead of only through a
 * subprocess, and the cutover is the part that needed testing most.
 *
 * WHAT THIS MODULE IS NOW
 * -----------------------
 * Argument parsing, presentation, and exit codes. Nothing else. Every mutation
 * lives in `fluid/ideabox-ops.js`, which the REST API calls too — including the
 * two invariants that used to be spelled out here and would have had to be
 * re-remembered by every new surface:
 *
 *   1. the migration gate runs before any write, and
 *   2. the projection is rewritten only after the record is durable.
 *
 * A surface that does not implement an invariant cannot forget it. That is the
 * whole reason the ops module exists; see its header for the failure it prevents.
 *
 * Behaviour is preserved deliberately, including output wording, exit codes and
 * flag parsing, because a cutover that also redesigns the commands cannot be
 * reviewed: any difference becomes ambiguous between "intended" and
 * "regression". The exceptions are documented — `normalizeTags` in the ops
 * module, the killed-idea promote refusal (D22), and the new `resurrect`
 * subcommand (D23).
 */

import { existsSync } from 'node:fs';

import {
  ideaboxContext,
  addIdea,
  addDiscussion,
  killIdea,
  promoteIdea,
  resurrectIdea,
  setPriority,
  updateIdea,
  IdeaboxConflict,
  IdeaboxInvalid,
  IdeaboxNotFound,
} from './fluid/ideabox-ops.js';
import { toMarkdownDate } from './fluid/ideabox-dates.js';
import { KIND } from './fluid/provider.js';
import { ensureIdeaboxMigrated } from './fluid/ideabox-migrate.js';
import { writeIdeaboxProjection } from './fluid/render-ideabox.js';

const USAGE = [
  'Usage: compose ideabox <subcommand>',
  '',
  'Subcommands:',
  '  add "<title>"                Add a new idea',
  '  list                         List all ideas',
  '  promote <ID>                 Mark idea as PROMOTED (creates feature folder)',
  '  kill <ID> "<reason>"         Move idea to Killed Ideas',
  '  resurrect <ID>               Return a killed idea to the live set',
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

/** Status enum → the legacy display label the list output has always used. */
const displayStatus = (record) => {
  if (record.status === 'promoted') return 'PROMOTED';
  if (record.status === 'discussing') return 'DISCUSSING';
  return 'NEW';
};

const displayPriority = (record) => record.priority ?? '—';

/**
 * Turn an op failure into the terminal's contract: a message on stderr and a
 * non-zero exit. Only the ops' own typed failures are handled — anything else
 * is a bug or a broken store, and swallowing those into a tidy exit code is how
 * a corrupt project looks healthy.
 */
function reportOpFailure(err) {
  if (err instanceof IdeaboxNotFound || err instanceof IdeaboxInvalid || err instanceof IdeaboxConflict) {
    console.error(err.message);
    return 1;
  }
  throw err;
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

  const ctx = await ideaboxContext(cwd, { config: opts.config, origin: 'cli:ideabox' });
  const { provider, ideaboxPath } = ctx;

  try {
    switch (sub) {
      case 'add': {
        const title = args.slice(1).find((a) => !a.startsWith('-')) || args[1];
        if (!title) {
          console.error('Usage: compose ideabox add "<title>" [--source "..."] [--desc "..."] [--cluster "..."]');
          return 1;
        }
        const { record, createdCluster } = await addIdea(ctx, {
          title,
          body: flagValue(args, '--desc') ?? '',
          source: flagValue(args, '--source') ?? '',
          tags: flagValue(args, '--tags') ?? [],
          cluster: flagValue(args, '--cluster') ?? null,
        });
        if (createdCluster) console.log(`Created cluster ${createdCluster.handle}: ${createdCluster.title}`);
        console.log(`Added ${record.handle}: ${record.title}`);
        return 0;
      }

      case 'list': {
        // Read-only paths still migrate: `list` on an upgraded project must show
        // the user's real ideas, not an empty store. It is the same import
        // either way, and running it lazily on first read rather than first
        // write means the upgrade happens at the least destructive moment
        // available.
        if (!existsSync(ideaboxPath) && !(await provider.listRecords({ kind: KIND.IDEA })).length) {
          console.log('No ideabox found. Run: compose ideabox add "<title>"');
          return 0;
        }
        await ensureIdeaboxMigrated(provider, ideaboxPath);
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
        const { record, featureCode, featurePath, createdFeature } =
          await promoteIdea(ctx, id, args[2] || '');
        if (createdFeature) console.log(`Created feature folder: ${featurePath}/`);
        console.log(`Promoted ${record.handle} → ${featureCode}`);
        return 0;
      }

      case 'kill': {
        const id = args[1];
        if (!id) {
          console.error('Usage: compose ideabox kill <ID> "<reason>"');
          return 1;
        }
        const reason = args[2] || '';
        const { record, alreadyKilled } = await killIdea(ctx, id, reason);
        if (alreadyKilled) {
          console.log(`${record.handle} was already killed on ${toMarkdownDate(record.killed?.at)}: ${record.killed?.reason ?? ''}`);
        } else {
          console.log(`Killed ${record.handle}: ${reason}`);
        }
        return 0;
      }

      case 'resurrect': {
        const id = args[1];
        if (!id) {
          console.error('Usage: compose ideabox resurrect <ID>');
          return 1;
        }
        const { record } = await resurrectIdea(ctx, id);
        console.log(`Resurrected ${record.handle}: ${record.title}`);
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
        const { record } = await setPriority(ctx, id, priority);
        console.log(`Set ${record.handle} priority → ${priority}`);
        return 0;
      }

      case 'discuss': {
        const id = args[1];
        const comment = args[2];
        if (!id || !comment) {
          console.error('Usage: compose ideabox discuss <ID> "<comment>"');
          return 1;
        }
        await addDiscussion(ctx, id, { text: comment, author: 'human' });
        console.log(`[${new Date().toISOString().slice(0, 10)}] human: ${comment}`);
        return 0;
      }

      case 'triage': {
        const lensName = flagValue(args, '--lens');
        await ensureIdeaboxMigrated(provider, ideaboxPath);
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
              // The record write only. Triage is a bulk pass, so it renders once
              // at the end rather than rewriting the whole file per answer.
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
          await writeIdeaboxProjection(provider, ideaboxPath);
          console.log('\nSaved.');
        }
        return 0;
      }

      case 'render': {
        // The repair path. Every mutation writes the record before the
        // projection, so a failed render leaves durable canon and a stale file;
        // this is how the file catches up without touching a record. Also the
        // fix for a projection that was interrupted, and the way back from any
        // hand edit.
        await ensureIdeaboxMigrated(provider, ideaboxPath);
        await writeIdeaboxProjection(provider, ideaboxPath);
        console.log(`Rendered ${ideaboxPath}`);
        return 0;
      }

      default:
        console.error(`Unknown ideabox subcommand: ${sub}`);
        console.error('Run: compose ideabox --help');
        return 1;
    }
  } catch (err) {
    return reportOpFailure(err);
  }
}
