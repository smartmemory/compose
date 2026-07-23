/**
 * lib/judgment/store/records.js — the tracked-floor judgment canon store (S02).
 *
 * Records are canonical, git-tracked JSON under docs/judgment/records/
 * (the feature.json precedent — NOT the gitignored vision store):
 *
 *   positions/<slug>/r<N>.json   append-only revision chain; highest N is current
 *   people/<slug>.json           mutable person aggregate
 *   situation/<slug>.json        mutable situation aggregate
 *   goal/v<N>.json               append-only goal meaning chain
 *   goal/state.json              mutable goal associations sidecar
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

  _chainNumbers({ dir, prefix }) {
    if (!existsSync(dir)) return [];
    const fileRe = new RegExp(`^${prefix}([1-9][0-9]*)\\.json$`);
    return readdirSync(dir)
      .map((file) => fileRe.exec(file))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
  }

  _appendChainRecord(config, record) {
    mkdirSync(config.dir, { recursive: true });
    const numbers = this._chainNumbers(config);
    const number = (numbers.length ? numbers[numbers.length - 1] : 0) + 1;
    const path = join(config.dir, `${config.prefix}${number}.json`);
    atomicWrite(
      path,
      JSON.stringify({ ...record, [config.numberField]: number }, null, 2) + '\n',
    );
    return {
      [config.numberField]: number,
      ref: config.ref(number),
      path,
    };
  }

  _readChainRecord(config, number) {
    return readJson(join(config.dir, `${config.prefix}${number}.json`));
  }

  _readChain(config) {
    return this._chainNumbers(config)
      .map((number) => this._readChainRecord(config, number))
      .filter(Boolean);
  }

  _latestChainRecord(config) {
    const numbers = this._chainNumbers(config);
    if (numbers.length === 0) return null;
    return this._readChainRecord(config, numbers[numbers.length - 1]);
  }

  _replaceChainRecord(config, number, record) {
    mkdirSync(config.dir, { recursive: true });
    const path = join(config.dir, `${config.prefix}${number}.json`);
    atomicWrite(
      path,
      JSON.stringify({ ...record, [config.numberField]: number }, null, 2) + '\n',
    );
    return {
      [config.numberField]: number,
      ref: config.ref(number),
      path,
    };
  }

  _positionDir(slug) {
    return join(this.root, 'positions', slug);
  }

  _positionChain(slug) {
    return {
      dir: this._positionDir(slug),
      prefix: 'r',
      numberField: 'rev',
      ref: (rev) => `${slug}#r${rev}`,
    };
  }

  _revNumbers(slug) {
    return this._chainNumbers(this._positionChain(slug));
  }

  /**
   * Append the next revision of a chain. Stamps `rev` (next N); revisions are
   * immutable once written — this never overwrites an existing r<N>.json.
   * @returns {{ rev: number, ref: string, path: string }}
   */
  writePositionRevision(record) {
    return this._appendChainRecord(this._positionChain(record.slug), record);
  }

  /** Full chain, ascending by rev. */
  readPositionChain(slug) {
    return this._readChain(this._positionChain(slug));
  }

  readPositionRevision(slug, rev) {
    return this._readChainRecord(this._positionChain(slug), rev);
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
    return this._latestChainRecord(this._positionChain(slug));
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

  // ── goal ─────────────────────────────────────────────────────────────────

  _goalDir() {
    return join(this.root, 'goal');
  }

  _goalChain() {
    return {
      dir: this._goalDir(),
      prefix: 'v',
      numberField: 'version',
      ref: (version) => `goal:v${version}`,
    };
  }

  writeGoalVersion(record) {
    return this._appendChainRecord(this._goalChain(), record);
  }

  readGoalVersion(version) {
    return this._readChainRecord(this._goalChain(), version);
  }

  readGoalChain() {
    return this._readChain(this._goalChain());
  }

  latestGoalVersion() {
    return this._latestChainRecord(this._goalChain());
  }

  replaceGoalVersion(version, record) {
    return this._replaceChainRecord(this._goalChain(), version, record);
  }

  _goalStatePath() {
    return join(this._goalDir(), 'state.json');
  }

  writeGoalState(record) {
    mkdirSync(this._goalDir(), { recursive: true });
    atomicWrite(this._goalStatePath(), JSON.stringify(record, null, 2) + '\n');
    return { path: this._goalStatePath() };
  }

  readGoalState() {
    return readJson(this._goalStatePath());
  }

  // ── people ───────────────────────────────────────────────────────────────

  _personPath(slug) {
    return join(this.root, 'people', `${slug}.json`);
  }

  writePerson(record) {
    mkdirSync(join(this.root, 'people'), { recursive: true });
    atomicWrite(this._personPath(record.slug), JSON.stringify(record, null, 2) + '\n');
    return { slug: record.slug };
  }

  readPerson(slug) {
    return readJson(this._personPath(slug));
  }

  listPeople() {
    const dir = join(this.root, 'people');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => readJson(join(dir, file)))
      .filter(Boolean);
  }

  // ── situation ────────────────────────────────────────────────────────────

  _situationEntityPath(slug) {
    return join(this.root, 'situation', `${slug}.json`);
  }

  writeSituationEntity(record) {
    mkdirSync(join(this.root, 'situation'), { recursive: true });
    atomicWrite(
      this._situationEntityPath(record.slug),
      JSON.stringify(record, null, 2) + '\n',
    );
    return { slug: record.slug };
  }

  readSituationEntity(slug) {
    return readJson(this._situationEntityPath(slug));
  }

  listSituationEntities() {
    const dir = join(this.root, 'situation');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => readJson(join(dir, file)))
      .filter(Boolean);
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
    try {
      unlinkSync(this._intentPath(id));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
}
