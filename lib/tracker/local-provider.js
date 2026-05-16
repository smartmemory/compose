import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { readFeature, listFeatures as listFeaturesRaw, writeFeature } from '../feature-json.js';
import { loadFeaturesDir } from '../project-paths.js';
import { TrackerProvider, CAP } from './provider.js';

import { setFeatureStatus, addRoadmapEntry as addRoadmapEntryRaw } from '../feature-writer.js';
import { recordCompletion as recordCompletionRaw } from '../completion-writer.js';
import { addChangelogEntry } from '../changelog-writer.js';
import { appendEvent as appendEventRaw, readEvents as readEventsRaw } from '../feature-events.js';
import { generateRoadmap } from '../roadmap-gen.js';
import { writeJournalEntry as writeJournalEntryRaw, getJournalEntries } from '../journal-writer.js';

// Normalized event type map: maps raw writer tool strings → cross-provider type tokens.
// Readers downstream use `type`, never `tool`, for portability across providers.
const TOOL_TYPE = {
  set_feature_status:  'status',
  record_completion:   'completion',
  add_roadmap_entry:   'roadmap',
  add_changelog_entry: 'changelog',
  write_journal_entry: 'journal',
  link_artifact:       'artifact',
  link_features:       'link',
  propose_followup:    'followup',
  roadmap_drift:       'drift',
};

// Inverse map: normalized type token → raw writer tool string (for write-side symmetry).
const TYPE_TOOL = Object.fromEntries(Object.entries(TOOL_TYPE).map(([tool, type]) => [type, tool]));

export class LocalFileProvider extends TrackerProvider {
  name() { return 'local'; }

  capabilities() {
    return new Set([CAP.FEATURES, CAP.EVENTS, CAP.ROADMAP, CAP.CHANGELOG, CAP.JOURNAL, CAP.VISION]);
  }

  async init(cwd) {
    this.cwd = cwd;
    this.featuresDir = loadFeaturesDir(cwd);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Feature CRUD
  // ---------------------------------------------------------------------------

  async getFeature(code) {
    return readFeature(this.cwd, code, this.featuresDir);
  }

  async listFeatures() {
    return listFeaturesRaw(this.cwd, this.featuresDir);
  }

  async createFeature(code, obj) {
    const existing = readFeature(this.cwd, code, this.featuresDir);
    if (existing) return existing;
    // writeFeature takes (cwd, featureObj, featuresDir) — featureObj.code drives the path
    writeFeature(this.cwd, { ...obj, code }, this.featuresDir);
    return readFeature(this.cwd, code, this.featuresDir);
  }

  async putFeature(code, obj) {
    const cur = readFeature(this.cwd, code, this.featuresDir);
    if (cur && Object.prototype.hasOwnProperty.call(obj, 'status') && obj.status !== cur.status) {
      throw new Error(`putFeature: status delta (${cur.status}->${obj.status}) not allowed; use setStatus`);
    }
    writeFeature(this.cwd, { ...obj, code }, this.featuresDir);
    return readFeature(this.cwd, code, this.featuresDir);
  }

  // ---------------------------------------------------------------------------
  // Status + Completion
  // ---------------------------------------------------------------------------

  async setStatus(code, to, meta = {}) {
    return setFeatureStatus(this.cwd, { code, status: to, ...meta });
  }

  async recordCompletion(code, rec) {
    return recordCompletionRaw(this.cwd, { feature_code: code, ...rec });
  }

  // ---------------------------------------------------------------------------
  // Roadmap
  // ---------------------------------------------------------------------------

  async addRoadmapEntry(args) {
    return addRoadmapEntryRaw(this.cwd, args);
  }

  async renderRoadmap() {
    return generateRoadmap(this.cwd);
  }

  // ---------------------------------------------------------------------------
  // Events — normalize raw writer `tool` field to cross-provider `type` token
  // ---------------------------------------------------------------------------

  async appendEvent(code, event) {
    const tool = event.tool ?? TYPE_TOOL[event.type];
    if (!tool) throw new Error(`appendEvent: cannot resolve writer tool from event (need .tool or a known .type; got type=${event.type})`);
    const { type, ...rest } = event;  // strip normalized alias; raw store keeps native tool shape
    return appendEventRaw(this.cwd, { code, tool, ...rest });
  }

  async readEvents(code) {
    const raw = readEventsRaw(this.cwd, { code });
    return raw.map(e => ({ ...e, type: e.type ?? TOOL_TYPE[e.tool] ?? e.tool }));
  }

  // ---------------------------------------------------------------------------
  // Changelog
  // ---------------------------------------------------------------------------

  async getChangelog() {
    const p = join(this.cwd, 'CHANGELOG.md');
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf-8');
  }

  async appendChangelog(entry) {
    return addChangelogEntry(this.cwd, entry);
  }

  // ---------------------------------------------------------------------------
  // Journal
  // ---------------------------------------------------------------------------

  async readJournal() {
    return getJournalEntries(this.cwd);
  }

  async writeJournalEntry(e) {
    return writeJournalEntryRaw(this.cwd, e);
  }

  // ---------------------------------------------------------------------------
  // Vision state — instantiate VisionStore per call (cwd-scoped, no singleton)
  // ---------------------------------------------------------------------------

  async getVisionState() {
    const { VisionStore } = await import('../../server/vision-store.js');
    const store = new VisionStore(join(this.cwd, '.compose', 'data'));
    return store.getState();
  }

  async putVisionState(s) {
    const { VisionStore } = await import('../../server/vision-store.js');
    const store = new VisionStore(join(this.cwd, '.compose', 'data'));
    // Restore items, connections, gates from the supplied state snapshot
    store.items       = new Map((s.items       ?? []).map(i => [i.id, i]));
    store.connections = new Map((s.connections ?? []).map(c => [c.id, c]));
    store.gates       = new Map((s.gates       ?? []).map(g => [g.id, g]));
    store._save();
    return store.getState();
  }
}
