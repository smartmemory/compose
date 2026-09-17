/**
 * Process supervisor for Compose.
 * Manages three independent processes:
 *   1. API server (port 4001) — Express + file-watcher + vision
 *   2. Agent server (port 4002) — SDK streaming, structured messages (Tier 1, immortal)
 *   3. Vite dev server (port 5195) — Frontend HMR
 *
 * Each process gets independent restart with exponential backoff.
 * If a process keeps crashing for > 1 minute, the supervisor gives up on it.
 *
 * Singleton enforcement: Uses an ownership record to ensure only one supervisor
 * runs. Same-project restarts replace the old process; cross-project starts must
 * be explicit takeovers.
 */

import { fork, spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPOSE_HOME, getTargetRoot, ensureDataDir } from './project-root.js';
import {
  decideSupervisorOwnership,
  readSupervisorRecord,
  writeSupervisorRecord,
} from './supervisor-ownership.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
console.log('[supervisor] Target project:', getTargetRoot());
const PID_FILE = path.join(COMPOSE_HOME, '.compose-supervisor.pid');
const VITE_BIN = path.join(COMPOSE_HOME, 'node_modules', '.bin', 'vite');
const IS_SOURCE_CHECKOUT = fs.existsSync(path.join(COMPOSE_HOME, '.git'));

const PROCESSES = [
  {
    name: 'api-server',
    path: path.join(__dirname, 'index.js'),
    port: process.env.PORT || 4001,
    type: 'fork',
  },
  {
    name: 'agent-server',
    path: path.join(__dirname, 'agent-server.js'),
    port: process.env.AGENT_PORT || 4002,
    type: 'fork',
  },
];

if (IS_SOURCE_CHECKOUT) {
  delete process.env.COMPOSE_PACKAGED_UI;
  if (!fs.existsSync(VITE_BIN)) {
    console.error(`[supervisor] Vite is required in a Compose source checkout but was not found at ${VITE_BIN}`);
    console.error(`[supervisor] Run \`npm install\` in ${COMPOSE_HOME}, then retry \`compose start\`.`);
    process.exit(1);
  }
  PROCESSES.push({
    name: 'vite',
    command: VITE_BIN,
    port: process.env.VITE_PORT || 5195,
    type: 'spawn',
  });
} else {
  process.env.COMPOSE_PACKAGED_UI = '1';
  console.log('[supervisor] Packaged install: serving cockpit from dist/ through the API server');
}

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 10_000;
const HEALTHY_THRESHOLD = 5_000;
const GIVE_UP_AFTER = 60_000; // stop retrying after 1 min of continuous failures

let stopping = false;

function ensureComposeApiToken() {
  if (!process.env.COMPOSE_API_TOKEN) {
    process.env.COMPOSE_API_TOKEN = crypto.randomBytes(24).toString('hex');
    console.log('[supervisor] Generated COMPOSE_API_TOKEN for this session');
  }
  // Expose the same token to Vite client code.
  process.env.VITE_COMPOSE_API_TOKEN = process.env.COMPOSE_API_TOKEN;
  // Expose AGENT_PORT so AgentStream.jsx can reach the right port
}

// --- Singleton enforcement ---

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM still proves that the process exists; only ESRCH means it is stale.
    return err?.code !== 'ESRCH';
  }
}

function killExistingSupervisor() {
  const record = readSupervisorRecord(PID_FILE);
  const targetRoot = getTargetRoot();
  const decision = decideSupervisorOwnership({
    record,
    currentPid: process.pid,
    currentTargetRoot: targetRoot,
    takeover: process.argv.includes('--takeover'),
    processAlive: record ? isProcessAlive(record.pid) : false,
  });

  if (decision.action === 'refuse') {
    console.error(
      `[supervisor] Refusing to start: supervisor PID ${decision.pid} is already serving ${decision.targetRoot}.`,
    );
    console.error(
      `[supervisor] Re-run with \`compose start --takeover\` to stop it and serve ${targetRoot}.`,
    );
    process.exit(1);
  }

  if (decision.action === 'takeover') {
    console.log(
      `[supervisor] Taking over from ${decision.targetRoot} (PID ${decision.pid})...`,
    );
  } else if (decision.action === 'restart') {
    console.log(`[supervisor] Killing previous supervisor (PID ${decision.pid})...`);
  } else {
    return;
  }

  try {
    process.kill(decision.pid, 'SIGTERM');
    // Give it time to clean up children
    execFileSync('sleep', ['2']);
  } catch {
    // The process exited between the liveness check and the signal.
  }
}

function writePidFile() {
  writeSupervisorRecord(PID_FILE, {
    pid: process.pid,
    targetRoot: getTargetRoot(),
    startedAt: new Date().toISOString(),
  });
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// Kill old supervisor before anything else
killExistingSupervisor();
ensureComposeApiToken();
ensureDataDir();

// Kill anything listening on our ports (stale children from old supervisor)
function freePort(port, childPid) {
  try {
    const output = execFileSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    if (!output) return;

    const myPid = process.pid;
    const pids = output.split('\n').map(p => parseInt(p, 10)).filter(Boolean);
    const stale = pids.filter(pid => pid !== myPid && pid !== childPid);

    if (stale.length > 0) {
      console.log(`[supervisor] Killing stale listener(s) on port ${port}: ${stale.join(', ')}`);
      for (const pid of stale) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      execFileSync('sleep', ['1']);
    }
  } catch {
    // lsof returns non-zero if no matches — port is free
  }
}

// Free all ports before starting (clean slate)
for (const proc of PROCESSES) {
  if (proc.port) freePort(proc.port, null);
}

// Write our PID file
writePidFile();

// --- Process management ---

function startProcess(proc) {
  if (stopping) return;
  if (proc.port) freePort(proc.port, proc.child ? proc.child.pid : null);

  const startTime = Date.now();
  console.log(`[supervisor] Starting ${proc.name}...`);

  if (proc.type === 'fork') {
    const forkEnv = { ...process.env };
    if (proc.name !== 'api-server') {
      // agent-server stays 127.0.0.1 always — never gets remote-auth env
      delete forkEnv.COMPOSE_HOST;
      delete forkEnv.COMPOSE_REMOTE_AUTH;
    }
    proc.child = fork(proc.path, { stdio: 'inherit', env: forkEnv });
  } else {
    proc.child = spawn(proc.command, [], {
      stdio: 'inherit',
      cwd: COMPOSE_HOME,
      env: process.env,
    });
  }

  proc.child.on('exit', (code, signal) => {
    if (stopping) return;

    const uptime = Date.now() - startTime;
    console.error(`[supervisor] ${proc.name} exited (code: ${code}, signal: ${signal}, uptime: ${uptime}ms)`);
    proc.child = null;

    if (uptime > HEALTHY_THRESHOLD) {
      proc.backoff = MIN_BACKOFF;
      proc.firstFailTime = null;
    } else {
      proc.backoff = Math.min((proc.backoff || MIN_BACKOFF) * 2, MAX_BACKOFF);
      if (!proc.firstFailTime) proc.firstFailTime = Date.now();

      if (Date.now() - proc.firstFailTime > GIVE_UP_AFTER) {
        console.error(`[supervisor] ${proc.name} has been failing for >1 min — giving up`);
        return;
      }
    }

    console.log(`[supervisor] Restarting ${proc.name} in ${proc.backoff}ms...`);
    setTimeout(() => startProcess(proc), proc.backoff);
  });
}

// Start all processes
for (const proc of PROCESSES) {
  proc.backoff = MIN_BACKOFF;
  proc.child = null;
  proc.firstFailTime = null;
  startProcess(proc);
}

// Forward termination signals to all children, then exit cleanly
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    console.log(`[supervisor] ${sig} received, stopping all processes...`);
    for (const proc of PROCESSES) {
      if (proc.child) proc.child.kill(sig);
    }
    removePidFile();
    setTimeout(() => process.exit(0), 2000);
  });
}
