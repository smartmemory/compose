import fs from 'node:fs';
import path from 'node:path';

function isPositivePid(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * Read the supervisor ownership record. Legacy files containing only a PID are
 * accepted so upgrades do not fail during their first restart.
 */
export function readSupervisorRecord(file) {
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (/^\d+$/.test(content)) {
      const pid = Number(content);
      return isPositivePid(pid)
        ? { pid, targetRoot: null, startedAt: null, legacy: true }
        : null;
    }

    const record = JSON.parse(content);
    if (
      !record
      || typeof record !== 'object'
      || Array.isArray(record)
      || !isPositivePid(record.pid)
      || typeof record.targetRoot !== 'string'
      || !record.targetRoot
      || typeof record.startedAt !== 'string'
      || !record.startedAt
    ) {
      return null;
    }
    return {
      pid: record.pid,
      targetRoot: record.targetRoot,
      startedAt: record.startedAt,
    };
  } catch {
    return null;
  }
}

/** Write a project-owned supervisor record at the legacy PID-file path. */
export function writeSupervisorRecord(file, record) {
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * Decide how startup should handle an existing ownership record. This is pure:
 * the caller supplies the already-observed liveness state and performs effects.
 */
export function decideSupervisorOwnership({
  record,
  currentPid,
  currentTargetRoot,
  takeover,
  processAlive,
}) {
  if (!record || record.pid === currentPid || !processAlive) {
    return { action: 'proceed' };
  }

  // A legacy record has no project identity. Preserve the pre-upgrade restart
  // behavior once; every replacement record written afterward is project-owned.
  if (!record.targetRoot || path.resolve(record.targetRoot) === path.resolve(currentTargetRoot)) {
    return { action: 'restart', pid: record.pid, targetRoot: record.targetRoot };
  }

  return {
    action: takeover ? 'takeover' : 'refuse',
    pid: record.pid,
    targetRoot: record.targetRoot,
  };
}
