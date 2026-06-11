/**
 * cli-remote.js — COMP-MOBILE-REMOTE S03
 *
 * Logic for `compose remote` CLI verbs.
 * Extracted to lib/ so tests can import without spawning the CLI binary.
 *
 * Exports:
 *   runRemoteCommand(subArgs, opts) — dispatches to the appropriate verb.
 *
 * opts shape:
 *   port       {number}    Server port (default: 4001)
 *   token      {string}    COMPOSE_API_TOKEN value (default: process.env.COMPOSE_API_TOKEN)
 *   cwd        {string}    Project root
 *   lines      {object}    Output collector with .push(line) (default: console.log)
 *   qr         {function}  QR renderer: (url: string) => void | Promise<void>
 *   poll       {function}  Delay function: (ms: number) => Promise<void>
 *   distDir    {string}    Path to dist/ (for status verb)
 *   headFn     {function}  HEAD check: (url: string) => Promise<{ok, status}>
 *
 * @module lib/cli-remote
 */

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_HOME = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request to the local compose server.
 * Returns { status, body }.
 */
function serverRequest(port, urlPath, { method = 'GET', body, headers = {} } = {}) {
  const data = body ? JSON.stringify(body) : null;
  const opts = {
    hostname: '127.0.0.1',
    port,
    path: urlPath,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...headers,
    },
  };
  return new Promise((res, rej) => {
    const req = http.request(opts, (response) => {
      let buf = '';
      response.on('data', (d) => { buf += d; });
      response.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch {}
        res({ status: response.statusCode, body: parsed });
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HEAD check helper (for status verb)
// ---------------------------------------------------------------------------

async function defaultHeadCheck(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ ok: false, status: 0 });
    }
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
    };
    const req = http.request(options, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 400, status: res.statusCode });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// compose.json helpers
// ---------------------------------------------------------------------------

/**
 * Read .compose/compose.json from a project root. Returns {} on error.
 */
function readComposeJson(cwd) {
  const cfgPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(cfgPath)) return {};
  try { return JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { return {}; }
}

/**
 * Write .compose/compose.json, preserving ALL unknown keys.
 * Spreads existing top-level keys first, then merges patch.
 * For object-valued patch keys, deep-merges with existing sub-object.
 */
function writeComposeJson(cwd, patch) {
  const cfgPath = join(cwd, '.compose', 'compose.json');
  const existing = readComposeJson(cwd);
  const merged = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      merged[k] = { ...(existing[k] || {}), ...v };
    } else {
      merged[k] = v;
    }
  }
  writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
}

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a --flag=value or --flag value style arg from an args array.
 * Returns the value string or undefined.
 */
function parseFlag(args, name) {
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(prefix)) return args[i].slice(prefix.length);
    if (args[i] === `--${name}` && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      return args[i + 1];
    }
  }
  return undefined;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Verb: pair
// ---------------------------------------------------------------------------

async function verbPair(subArgs, { port, token, cwd, out, qrFn, pollFn }) {
  if (!token) {
    out.push('Error: COMPOSE_API_TOKEN is not set.');
    out.push('The compose server must be running and COMPOSE_API_TOKEN must be exported.');
    out.push('Tip: start the server with `compose start`, then run this command in the same shell session.');
    throw new Error('COMPOSE_API_TOKEN not set');
  }

  // Resolve public_host: --public-host flag > compose.json remote.public_host
  const flagHost = parseFlag(subArgs, 'public-host');
  const cfg = readComposeJson(cwd);
  const publicHost = flagHost || cfg.remote?.public_host || null;

  // Persist public_host to compose.json if flag was given (preserving unknown keys)
  if (flagHost) {
    writeComposeJson(cwd, { remote: { public_host: flagHost } });
  }

  // Call pair/init
  let initResult;
  try {
    initResult = await serverRequest(port, '/api/auth/pair/init', {
      method: 'POST',
      body: {},
      headers: { 'x-compose-token': token },
    });
  } catch (err) {
    out.push(`Error: Could not reach compose server on port ${port}.`);
    out.push('Make sure the server is running: compose start');
    throw err;
  }

  if (initResult.status !== 200) {
    out.push(`Error from server (${initResult.status}): ${JSON.stringify(initResult.body)}`);
    throw new Error(`pair/init failed: ${initResult.status}`);
  }

  const { code, expires_at } = initResult.body;

  // Build pair URL
  let pairUrl;
  if (publicHost) {
    pairUrl = `${publicHost.replace(/\/$/, '')}/m/pair?code=${code}`;
  } else {
    pairUrl = `http://127.0.0.1:${port}/m/pair?code=${code}`;
    out.push('WARNING: No public_host configured. Generating a localhost URL (only usable on this machine).');
    out.push('Run with: compose remote pair --public-host=<your-tunnel-URL>');
  }

  out.push('');
  out.push(`Pair URL: ${pairUrl}`);
  out.push(`Code expires at: ${expires_at}`);
  out.push('');

  // Render QR code
  await qrFn(pairUrl);

  out.push('');
  out.push('Waiting for device to pair (Ctrl-C to cancel)...');

  // Poll pair/status every 2s until consumed, expired, or interrupted
  while (true) {
    await pollFn(2000);

    let statusResult;
    try {
      statusResult = await serverRequest(
        port,
        `/api/auth/pair/status?code=${encodeURIComponent(code)}`,
        { method: 'GET', headers: { 'x-compose-token': token } },
      );
    } catch {
      out.push('Warning: lost connection to server while polling.');
      break;
    }

    if (statusResult.status !== 200) {
      out.push(`Polling error (${statusResult.status}): ${JSON.stringify(statusResult.body)}`);
      break;
    }

    const status = statusResult.body.status;
    if (status === 'consumed') {
      out.push('Paired! Device successfully authenticated.');
      break;
    } else if (status === 'expired') {
      out.push('Pairing code expired. Run `compose remote pair` again to generate a new code.');
      break;
    }
    // status === 'pending' — continue polling
  }
}

// ---------------------------------------------------------------------------
// Verb: list
// ---------------------------------------------------------------------------

async function verbList(subArgs, { port, token, out }) {
  if (!token) {
    out.push('Error: COMPOSE_API_TOKEN is not set.');
    throw new Error('COMPOSE_API_TOKEN not set');
  }

  let result;
  try {
    result = await serverRequest(port, '/api/auth/devices', {
      method: 'GET',
      headers: { 'x-compose-token': token },
    });
  } catch {
    out.push(`Error: Could not reach compose server on port ${port}.`);
    out.push('Make sure the server is running: compose start');
    return;
  }

  if (result.status !== 200) {
    out.push(`Error from server (${result.status}): ${JSON.stringify(result.body)}`);
    return;
  }

  const devices = result.body.devices || [];
  if (devices.length === 0) {
    out.push('No paired devices.');
    return;
  }

  // Print table
  const COL = { id: 24, name: 30, paired_at: 26, last_seen: 26, revoked: 8 };
  const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
  const sep = '-'.repeat(COL.id + COL.name + COL.paired_at + COL.last_seen + COL.revoked + 8);

  out.push(
    `${pad('ID', COL.id)}  ${pad('Name', COL.name)}  ${pad('Paired At', COL.paired_at)}  ${pad('Last Seen', COL.last_seen)}  ${pad('Revoked', COL.revoked)}`,
  );
  out.push(sep);

  for (const d of devices) {
    out.push(
      `${pad(d.id, COL.id)}  ${pad(d.name, COL.name)}  ${pad(d.paired_at, COL.paired_at)}  ${pad(d.last_seen, COL.last_seen)}  ${pad(d.revoked, COL.revoked)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Verb: revoke
// ---------------------------------------------------------------------------

async function verbRevoke(subArgs, { port, token, out }) {
  const deviceId = subArgs.find((a) => !a.startsWith('--'));
  if (!deviceId) {
    out.push('Usage: compose remote revoke <device-id>');
    out.push('Get device IDs with: compose remote list');
    throw new Error('Missing device-id');
  }
  if (!token) {
    out.push('Error: COMPOSE_API_TOKEN is not set.');
    throw new Error('COMPOSE_API_TOKEN not set');
  }

  let result;
  try {
    result = await serverRequest(port, `/api/auth/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { 'x-compose-token': token },
    });
  } catch {
    out.push(`Error: Could not reach compose server on port ${port}.`);
    return;
  }

  if (result.status === 404) {
    out.push(`Device not found: ${deviceId}`);
    return;
  }
  if (result.status !== 200) {
    out.push(`Error from server (${result.status}): ${JSON.stringify(result.body)}`);
    return;
  }
  out.push(`Revoked device: ${deviceId}`);
}

// ---------------------------------------------------------------------------
// Verb: rotate-secret
// ---------------------------------------------------------------------------

async function verbRotateSecret(subArgs, { port, token, out }) {
  if (!hasFlag(subArgs, 'yes')) {
    out.push('Error: rotate-secret requires --yes to confirm.');
    out.push('This operation invalidates ALL paired device tokens immediately.');
    out.push('Devices will need to re-pair after rotation.');
    out.push('');
    out.push('To proceed: compose remote rotate-secret --yes');
    throw new Error('--yes required');
  }
  if (!token) {
    out.push('Error: COMPOSE_API_TOKEN is not set.');
    throw new Error('COMPOSE_API_TOKEN not set');
  }

  let result;
  try {
    result = await serverRequest(port, '/api/auth/rotate-secret', {
      method: 'POST',
      body: {},
      headers: { 'x-compose-token': token },
    });
  } catch {
    out.push(`Error: Could not reach compose server on port ${port}.`);
    return;
  }

  if (result.status !== 200) {
    out.push(`Error from server (${result.status}): ${JSON.stringify(result.body)}`);
    return;
  }
  out.push('Secret rotated successfully.');
  out.push('All paired device tokens are now invalid. Devices must re-pair.');
  out.push('Run `compose remote pair` to generate new pairing codes.');
}

// ---------------------------------------------------------------------------
// Verb: status
// ---------------------------------------------------------------------------

async function verbStatus(subArgs, { port, token, cwd, out, distDir, headFn }) {
  const cfg = readComposeJson(cwd);
  const publicHost = cfg.remote?.public_host || null;
  const remoteAuthFlag = process.env.COMPOSE_REMOTE_AUTH || 'disabled';

  // Resolve dist dir
  const resolvedDistDir = distDir || join(COMPOSE_HOME, 'dist');

  // Bind host (from env > config > default)
  const bindHost = process.env.COMPOSE_HOST || cfg.server?.host || '127.0.0.1';
  out.push(`Bind host:       ${bindHost}`);

  // Remote auth flag
  out.push(`Remote auth:     ${remoteAuthFlag}`);

  // Public host
  out.push(`Public host:     ${publicHost || 'not configured'}`);

  // dist/ presence
  const distExists = existsSync(resolvedDistDir);
  if (distExists) {
    out.push(`dist/ bundle:    present`);
  } else {
    out.push(`dist/ bundle:    MISSING — run npm run build before using remote access`);
  }

  // Paired device count (graceful on ECONNREFUSED)
  if (token) {
    try {
      const devResult = await serverRequest(port, '/api/auth/devices', {
        method: 'GET',
        headers: { 'x-compose-token': token },
      });
      if (devResult.status === 200) {
        const allDevices = devResult.body.devices || [];
        const activeCount = allDevices.filter((d) => !d.revoked).length;
        out.push(`Paired devices:  ${activeCount} active (${allDevices.length} total)`);
      } else {
        out.push(`Paired devices:  (could not read — server returned ${devResult.status})`);
      }
    } catch {
      out.push(`Paired devices:  (server not running on port ${port})`);
    }
  } else {
    out.push('Paired devices:  (COMPOSE_API_TOKEN not set — cannot query server)');
  }

  // Public host reachability check
  if (publicHost) {
    const headUrl = `${publicHost.replace(/\/$/, '')}/api/health`;
    out.push(`Checking: HEAD ${headUrl}`);
    const checkFn = headFn || defaultHeadCheck;
    try {
      const headResult = await checkFn(headUrl);
      if (headResult.ok) {
        out.push(`Public host:     reachable (HTTP ${headResult.status})`);
      } else {
        out.push(`Public host:     UNREACHABLE (HTTP ${headResult.status || 'no response'})`);
        out.push('Check that your tunnel is running and forwarding to port 4001.');
      }
    } catch {
      out.push('Public host:     UNREACHABLE (error during HEAD check)');
    }
  } else {
    out.push('');
    out.push('To configure remote access:');
    out.push('  1. Start a tunnel to port 4001 (Tailscale Funnel, Cloudflare Tunnel, ngrok, etc.)');
    out.push('  2. Run: compose remote pair --public-host=<your-tunnel-URL>');
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Run a remote subcommand.
 *
 * @param {string[]} subArgs  Arguments after "remote" (e.g. ['pair', '--public-host=...'])
 * @param {object}  opts
 * @param {number}  [opts.port=4001]        Server port
 * @param {string}  [opts.token]            COMPOSE_API_TOKEN (default: process.env.COMPOSE_API_TOKEN)
 * @param {string}  [opts.cwd]              Project root (default: process.cwd())
 * @param {object}  [opts.lines]            Output collector with .push(line) (default: prints to stdout)
 * @param {function}[opts.qr]               QR renderer: (url) => void | Promise<void>
 * @param {function}[opts.poll]             Delay: (ms) => Promise<void>
 * @param {string}  [opts.distDir]          Path to dist/ (status verb)
 * @param {function}[opts.headFn]           HEAD check fn (status verb)
 */
export async function runRemoteCommand(subArgs, opts = {}) {
  const {
    port = 4001,
    token = process.env.COMPOSE_API_TOKEN,
    cwd = process.cwd(),
    lines = null,
    qr = null,
    poll = null,
    distDir = undefined,
    headFn = undefined,
  } = opts;

  // Output collector: use provided array/object or fall back to stdout
  const out = lines || { push: (l) => console.log(l) };

  // Default QR renderer (qrcode-terminal, dynamically imported to avoid test dep issues)
  const qrFn = qr || (async (url) => {
    const { default: qrcode } = await import('qrcode-terminal');
    qrcode.generate(url, { small: true });
  });

  // Default poll (sleep)
  const pollFn = poll || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const sub = subArgs[0];
  const rest = subArgs.slice(1);

  const ctx = { port, token, cwd, out, qrFn, pollFn, distDir, headFn };

  switch (sub) {
    case 'pair':
      return verbPair(rest, ctx);

    case 'list':
      return verbList(rest, ctx);

    case 'revoke':
      return verbRevoke(rest, ctx);

    case 'rotate-secret':
      return verbRotateSecret(rest, ctx);

    case 'status':
      return verbStatus(rest, ctx);

    default: {
      out.push('Usage: compose remote <subcommand>');
      out.push('');
      out.push('Subcommands:');
      out.push('  pair [--public-host=URL] [--name=NAME]   Pair a new device via QR code');
      out.push('  list                                     List paired devices');
      out.push('  revoke <device-id>                       Revoke a paired device');
      out.push('  rotate-secret --yes                      Rotate JWT signing secret (invalidates all devices)');
      out.push('  status                                   Show remote config and server health');
      if (sub && sub !== '--help' && sub !== '-h') {
        out.push(`\nUnknown subcommand: ${sub}`);
      }
      break;
    }
  }
}
