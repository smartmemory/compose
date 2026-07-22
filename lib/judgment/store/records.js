/**
 * lib/judgment/store/records.js — the tracked-floor judgment canon store (S02).
 *
 * Records are canonical, git-tracked JSON under docs/judgment/records/
 * (the feature.json precedent — NOT the gitignored vision store):
 *
 *   positions/<slug>/r<N>.json   append-only revision chain; highest N is current
 *   joints/<slug>.json           one file per joint; state lives here
 *   predictions/<id>.json        spawned by CONSTRUCT/commit events
 *   intents/<id>.json            pending-intent records (intent-first transitions)
 *   ledger.jsonl                 append-only event stream
 *
 * Position status is DERIVED, never stored: a chain is `superseded` iff the
 * latest revision of a non-retracted chain elsewhere names it in `supersedes`;
 * `retracted` iff its own latest revision is a tombstone; `live` otherwise.
 *
 * All writes are atomic: `${path}.tmp.${process.pid}` + rename (the
 * feature-json.js:87-90 idiom — the pid-less journal-writer variant is a
 * known trap, do not copy it). The ledger append rewrites the whole stream
 * through the same tmp+rename path so a crash can never leave a torn line.
 */
import {
  readFileSync, writeFileSync, renameSync, unlinkSync,
  mkdirSync, readdirSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';

function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const REV_FILE_RE = /^r([1-9][0-9]*)\.json$/;

export class RecordsStore {
  /** @param {string} cwd project root */
  constructor(cwd) {
    this.cwd = cwd;
    this.root = join(cwd, 'docs', 'judgment', 'records');
  }

  /** Enrichment capabilities — the floor has none (W4 adds them via config, not here). */
  capabilities() {
    return new Set();
  }

  // ── positions ────────────────────────────────────────────────────────────

  _positionDir(slug) {
    return join(this.root, 'positions', slug);
  }

  _revNumbers(slug) {
    const dir = this._positionDir(slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => REV_FILE_RE.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  /**
   * Append the next revision of a chain. Stamps `rev` (next N); revisions are
   * immutable once written — this never overwrites an existing r<N>.json.
   * @returns {{ rev: number, ref: string, path: string }}
   */
  writePositionRevision(record) {
    const dir = this._positionDir(record.slug);
    mkdirSync(dir, { recursive: true });
    const revs = this._revNumbers(record.slug);
    const rev = (revs.length ? revs[revs.length - 1] : 0) + 1;
    const path = join(dir, `r${rev}.json`);
    atomicWrite(path, JSON.stringify({ ...record, rev }, null, 2) + '\n');
    return { rev, ref: `${record.slug}#r${rev}`, path };
  }

  /** Full chain, ascending by rev. */
  readPositionChain(slug) {
    return this._revNumbers(slug)
      .map((n) => readJson(join(this._positionDir(slug), `r${n}.json`)))
      .filter(Boolean);
  }

  readPositionRevision(slug, rev) {
    return readJson(join(this._positionDir(slug), `r${rev}.json`));
  }

  listPositionSlugs() {
    const dir = join(this.root, 'positions');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  /** Latest revision of a chain, or null. */
  latestPositionRevision(slug) {
    const revs = this._revNumbers(slug);
    if (revs.length === 0) return null;
    return this.readPositionRevision(slug, revs[revs.length - 1]);
  }

  /**
   * Derived chain status: 'live' | 'superseded' | 'retracted' | null (no chain).
   * Never stored anywhere — computed from the chains on every call.
   */
  derivePositionStatus(slug) {
    const latest = this.latestPositionRevision(slug);
    if (!latest) return null;
    if (latest.retracted === true) return 'retracted';
    for (const other of this.listPositionSlugs()) {
      if (other === slug) continue;
      const otherLatest = this.latestPositionRevision(other);
      if (!otherLatest || otherLatest.retracted === true) continue;
      const ref = otherLatest.supersedes;
      if (typeof ref === 'string' && ref.startsWith(`${slug}#r`)) return 'superseded';
    }
    return 'live';
  }

  // ── joints ───────────────────────────────────────────────────────────────

  _jointPath(slug) {
    return join(this.root, 'joints', `${slug}.json`);
  }

  writeJoint(record) {
    mkdirSync(join(this.root, 'joints'), { recursive: true });
    atomicWrite(this._jointPath(record.slug), JSON.stringify(record, null, 2) + '\n');
    return { slug: record.slug };
  }

  readJoint(slug) {
    return readJson(this._jointPath(slug));
  }

  listJoints() {
    const dir = join(this.root, 'joints');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => readJson(join(dir, f)))
      .filter(Boolean);
  }

  // ── predictions ──────────────────────────────────────────────────────────

  _predictionPath(id) {
    return join(this.root, 'predictions', `${id}.json`);
  }

  writePrediction(record) {
    mkdirSync(join(this.root, 'predictions'), { recursive: true });
    atomicWrite(this._predictionPath(record.id), JSON.stringify(record, null, 2) + '\n');
    return { id: record.id };
  }

  readPrediction(id) {
    return readJson(this._predictionPath(id));
  }

  listPredictions({ status } = {}) {
    const dir = join(this.root, 'predictions');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => readJson(join(dir, f)))
      .filter(Boolean)
      .filter((p) => (status ? p.status === status : true));
  }

  // ── ledger ───────────────────────────────────────────────────────────────

  _ledgerPath() {
    return join(this.root, 'ledger.jsonl');
  }

  /**
   * Append one event. Rewrites the stream via tmp+rename (atomic — a crash
   * mid-append can never leave a torn trailing line). Append-only: there is
   * no update or delete surface on this store.
   */
  appendLedgerEvent(event) {
    mkdirSync(this.root, { recursive: true });
    const path = this._ledgerPath();
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    atomicWrite(path, existing + JSON.stringify(event) + '\n');
    return { seq: existing.split('\n').filter(Boolean).length + 1 };
  }

  readLedgerEvents() {
    const path = this._ledgerPath();
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  }

  // ── pending intents ──────────────────────────────────────────────────────

  _intentPath(id) {
    return join(this.root, 'intents', `${id}.json`);
  }

  persistIntent(intent) {
    mkdirSync(join(this.root, 'intents'), { recursive: true });
    atomicWrite(this._intentPath(intent.id), JSON.stringify(intent, null, 2) + '\n');
    return { id: intent.id };
  }

  readIntents() {
    const dir = join(this.root, 'intents');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => readJson(join(dir, f)))
      .filter(Boolean);
  }

  clearIntent(id) {
    try { unlinkSync(this._intentPath(id)); } catch { /* already cleared */ }
  }
}
