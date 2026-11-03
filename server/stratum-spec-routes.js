/**
 * stratum-spec-routes.js — `/api/stratum-ui/specs` (COMP-SUBAPP-STRAT-AUTHOR-1): the Stratum flow
 * builder's Save / Open, backing the optional DataClient `listSpecs` / `readSpec` / `saveSpec`
 * (`stratum/ui/src/data-client.ts`).
 *
 *   GET  /api/stratum-ui/specs        → [{ name, updatedAt }]  builder-written files only
 *   GET  /api/stratum-ui/specs/:name  → the spec | 404
 *   POST /api/stratum-ui/specs/:name  {spec} → { ok: true, name, created } | { ok: false, code, message, errors? }
 *
 * Files are `<workspace>/pipelines/<name>.stratum.yaml`, the folder builds load templates from
 * (`lib/build.js`). The first line of every saved file is MARKER, and a save overwrites an existing
 * file ONLY when its first line is MARKER: a hand-written pipeline (build, bug-fix, ...) is never
 * replaced (409). A save is judged by the engine's own `validateSpec` (`ts/dist/ir/validate.js`)
 * first (422 with its errors) and lands through a temp file: a new name by link() (fails if the name
 * appeared meanwhile), an overwrite by rename(). No engine: save is refused (501), list/read still work.
 * A NEW name that a build would resolve to a shipped pipeline (bundled, preset, or an init-provisioned
 * name in a workspace without its own copy) is refused (409 RESERVED_NAME): a file under `pipelines/`
 * wins over those in `resolveTemplatePath`, so saving it would silently change what `compose build` runs.
 *
 * Mounted AFTER the workspace middleware so `req.workspace.root` names the request's workspace.
 * Skipped in remote mode, like the rest of `/api/stratum-ui` (no Compose auth gate on it).
 */
import { existsSync, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';
import { getTargetRoot } from './project-root.js';
import { resolveTemplatePath } from '../lib/build.js';
import { INIT_PROVISIONED_SPECS } from '../lib/pipeline-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const SPECS_PATH = '/api/stratum-ui/specs';
export const MARKER = '# saved by Compose pipeline builder';
export const SPEC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUFFIX = '.stratum.yaml';

/**
 * The built engine (`ts/dist`) the builder is judged by. Installed `@smartmemory/stratum` first, then
 * the sibling checkout (also from a worktree), the same order `resolveStratumBin` uses, so the engine
 * that validates a saved pipeline is the one that will run it. Null when neither has `ir/validate.js`.
 */
export function resolveStratumEngineDist({ requireResolve = require.resolve.bind(require), siblingDirs } = {}) {
  const candidates = [];
  try {
    candidates.push(join(dirname(requireResolve('@smartmemory/stratum/package.json')), 'dist'));
  } catch { /* not installed */ }
  candidates.push(...(siblingDirs ?? [resolve(__dirname, '..', '..', 'stratum', 'ts', 'dist'), resolve(__dirname, '..', '..', '..', '..', 'stratum', 'ts', 'dist')]));
  return candidates.find((dir) => existsSync(join(dir, 'ir', 'validate.js'))) ?? null;
}

function loadValidator(engineDist) {
  let loaded;
  return () => (loaded ??= import(pathToFileURL(join(realpathSync(engineDist), 'ir', 'validate.js')).href).then((m) => m.validateSpec));
}

async function firstLine(file) {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(MARKER.length + 2), 0, MARKER.length + 2, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0];
  } finally {
    await handle.close();
  }
}

/** 'absent' | 'ours' | 'foreign' (exists and not a regular builder-written file). */
async function ownership(file) {
  let st;
  try { st = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  if (!st.isFile()) return 'foreign';
  return (await firstLine(file)) === MARKER ? 'ours' : 'foreign';
}

/**
 * @param {import('express').Express} app
 * @param {{ remote?: boolean, engineDist?: string|null, rootFor?: (req) => string }} [options]
 *   rootFor: the workspace root for a request (default `req.workspace.root`, else getTargetRoot()).
 * @returns {boolean} true when mounted.
 */
export function attachStratumSpecRoutes(app, { remote = false, engineDist = resolveStratumEngineDist(), rootFor } = {}) {
  if (remote) return false;
  const validator = engineDist ? loadValidator(engineDist) : null;
  const rootOf = (req) => (rootFor ? rootFor(req) : (req.workspace?.root ?? getTargetRoot()));
  const dirFor = (req) => join(rootOf(req), 'pipelines');
  const refuse = (res, status, code, message, extra = {}) => res.status(status).json({ ok: false, code, message, ...extra });
  // Express 4 does not catch a rejected async handler: answer it instead of leaving the request hanging.
  const safe = (fn) => (req, res) => fn(req, res).catch((error) => {
    console.warn(`[stratum-spec-routes] ${req.method} ${req.originalUrl}: ${error?.message ?? error}`);
    if (!res.headersSent) refuse(res, 500, 'ERROR', String(error?.message ?? error));
  });

  app.get(SPECS_PATH, safe(async (req, res) => {
    const dir = dirFor(req);
    let names;
    try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return res.json([]); throw error; }
    const rows = [];
    for (const file of names) {
      if (!file.endsWith(SUFFIX)) continue;
      const name = file.slice(0, -SUFFIX.length);
      if (!SPEC_NAME.test(name)) continue;
      const path = join(dir, file);
      if ((await ownership(path)) !== 'ours') continue;
      rows.push({ name, updatedAt: (await lstat(path)).mtime.toISOString() });
    }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json(rows);
  }));

  app.get(`${SPECS_PATH}/:name`, safe(async (req, res) => {
    const { name } = req.params;
    if (!SPEC_NAME.test(name)) return refuse(res, 400, 'BAD_NAME', `name must match ${SPEC_NAME}`);
    const path = join(dirFor(req), `${name}${SUFFIX}`);
    const owner = await ownership(path);
    if (owner === 'absent') return refuse(res, 404, 'NOT_FOUND', `no saved pipeline ${name}`);
    if (owner !== 'ours') return refuse(res, 409, 'NOT_BUILDER_FILE', `${name}${SUFFIX} was not written by the pipeline builder`);
    res.json(YAML.parse(await readFile(path, 'utf8')));
  }));

  app.post(`${SPECS_PATH}/:name`, safe(async (req, res) => {
    const { name } = req.params;
    // JSON-only POST, as the package handler requires: a cross-site form cannot send it without a preflight.
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return refuse(res, 415, 'CONTENT_TYPE', 'application/json required');
    if (!SPEC_NAME.test(name)) return refuse(res, 400, 'BAD_NAME', `name must be lowercase letters, digits and dashes, 1-64 chars, starting with a letter or digit (got ${JSON.stringify(name)})`);
    const spec = req.body?.spec;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return refuse(res, 400, 'BAD_REQUEST', 'body needs a spec object');
    if (!validator) return refuse(res, 501, 'NO_ENGINE', 'no built Stratum engine (ts/dist) found, so the spec cannot be validated and is not saved');
    const verdict = (await validator())(spec);
    if (!verdict.ok) return refuse(res, 422, 'INVALID', `the engine rejected the spec (${verdict.errors.length} error${verdict.errors.length === 1 ? '' : 's'})`, { errors: verdict.errors });

    const dir = dirFor(req);
    const path = join(dir, `${name}${SUFFIX}`);
    const owner = await ownership(path);
    if (owner === 'foreign') return refuse(res, 409, 'NOT_BUILDER_FILE', `${name}${SUFFIX} exists and was not written by the pipeline builder; pick another name`);

    if (owner === 'absent') {
      // Ask the resolver builds use (never a copy of its name list): a path outside this workspace's pipelines/ is a shipped pipeline.
      const resolved = resolveTemplatePath(name, rootOf(req));
      // Named by kind and package-relative path, never the absolute one (it carries the home directory onto the screen).
      const kind = basename(dirname(resolved)) === 'presets' ? 'preset' : 'bundled';
      const shipped = resolve(resolved).startsWith(`${resolve(dir)}${sep}`)
        ? null
        : { kind, at: `${kind === 'preset' ? 'presets' : 'bundled'}/${basename(resolved)}` };
      const init = INIT_PROVISIONED_SPECS.includes(name) ? { kind: 'init-provisioned', at: `pipelines/${name}${SUFFIX}` } : null;
      const owned = shipped ?? init;
      if (owned) {
        const message = `${name} is the ${owned.kind} pipeline at ${owned.at}; pick another name`;
        return refuse(res, 409, 'RESERVED_NAME', message, { error: message });
      }
    }

    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${name}${SUFFIX}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, `${MARKER}\n${YAML.stringify(spec)}`, { flag: 'wx' });
      if (owner === 'absent') {
        try {
          await link(tmp, path);
        } catch (error) {
          if (error.code === 'EEXIST') return refuse(res, 409, 'NOT_BUILDER_FILE', `${name}${SUFFIX} appeared while saving; reopen and retry`);
          throw error;
        }
      } else {
        await rename(tmp, path);
      }
    } finally {
      await rm(tmp, { force: true });
    }
    res.status(owner === 'absent' ? 201 : 200).json({ ok: true, name, created: owner === 'absent' });
  }));

  return true;
}
