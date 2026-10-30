/**
 * process-publish.js — the loopback link and pointer page for the Process view (COMP-COCKPIT-13 U3).
 *
 * Export policy (owner decision, decision.md "publish is Mac-only"): the only thing that may leave the Mac is a page
 * holding the 127.0.0.1 deep link, a generated time and a fixed header. `renderPointerPage` takes `{url, generatedAt}`
 * and nothing else, so no Process figure can reach it. The base URL comes only from env and the checkout check, never
 * from a request, and `pointerUrl` parses it and refuses anything that is not an http loopback host.
 */
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const DEFAULT_VITE_PORT = 5195; // server/supervisor.js: process.env.VITE_PORT || 5195
export const DEFAULT_SERVER_PORT = 4001; // server/index.js: process.env.PORT || 4001
export const DEFAULT_POINTER_FILE = join('.compose', 'data', 'process-pointer.html');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class PublishRefused extends Error {
  constructor(message) { super(message); this.name = 'PublishRefused'; this.code = 'NON_LOOPBACK'; }
}

/** A source checkout has Vite and src/ (a published install has neither, `server/index.js` serves dist/ on :4001). */
export const detectSourceCheckout = (root) => existsSync(join(root, 'src')) && existsSync(join(root, 'vite.config.js'));

const portOr = (value, fallback) => {
  const s = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return fallback;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : fallback;
};

/** The unchecked base: `COMPOSE_COCKPIT_URL`, else the source-checkout or packaged loopback port. */
export function cockpitBaseUrl({ env = process.env, hasSourceCheckout = false } = {}) {
  const set = typeof env.COMPOSE_COCKPIT_URL === 'string' ? env.COMPOSE_COCKPIT_URL.trim() : '';
  if (set) return set;
  const port = hasSourceCheckout ? portOr(env.VITE_PORT, DEFAULT_VITE_PORT) : portOr(env.PORT, DEFAULT_SERVER_PORT);
  return `http://127.0.0.1:${port}`;
}

/** Parses `base`, requires http: and an exact loopback hostname, and returns `<origin>/?view=process`. */
export function pointerUrl(base) {
  let u;
  try { u = new URL(String(base)); } catch { throw new PublishRefused('cockpit URL is not a valid URL'); }
  if (u.protocol !== 'http:') throw new PublishRefused(`cockpit URL scheme ${u.protocol} is not http:`);
  if (u.username || u.password) throw new PublishRefused('cockpit URL carries credentials');
  if (!LOOPBACK_HOSTS.has(u.hostname)) throw new PublishRefused(`cockpit host ${u.hostname} is not 127.0.0.1, localhost or [::1]`);
  return `${u.protocol}//${u.host}/?view=process`;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Fixed template: no script, no fetch, one link. The URL appears twice: the href and selectable text. */
export function renderPointerPage({ url, generatedAt }) {
  const u = escapeHtml(url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Process metrics: open on this Mac</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; line-height: 1.5;">
<h1>Process metrics: open on this Mac</h1>
<p>The figures stay on the Mac. This page only holds the link.</p>
<p><a href="${u}">Open the Process view</a></p>
<p>If the link does not open, copy this address into a browser on the Mac:</p>
<p><code>${u}</code></p>
<p>Generated ${escapeHtml(generatedAt)}</p>
</body>
</html>
`;
}

/** Atomic write (temp in the same directory, then rename). Refuses a directory target. Returns the path. */
export function writePointerPage(path, html) {
  let isDir = false;
  try { isDir = statSync(path).isDirectory(); } catch { /* not there yet */ }
  if (isDir) throw new Error(`${path} is a directory`);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, html);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  return path;
}

/** One call for the route and the CLI: `{url, generatedAt}` or throws PublishRefused. */
export function buildPointer({ env = process.env, hasSourceCheckout = false, now = Date.now } = {}) {
  return { url: pointerUrl(cockpitBaseUrl({ env, hasSourceCheckout })), generatedAt: new Date(now()).toISOString() };
}
