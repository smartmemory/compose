export const CAP = Object.freeze({
  FEATURES: 'FEATURES', EVENTS: 'EVENTS', ROADMAP: 'ROADMAP',
  CHANGELOG: 'CHANGELOG', JOURNAL: 'JOURNAL', VISION: 'VISION',
});

export class TrackerConfigError extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'TrackerConfigError'; this.detail = detail; }
}
export class TrackerConflictError extends Error {
  constructor(message, detail = {}) { super(message); this.name = 'TrackerConflictError'; this.detail = detail; }
}

const NI = (m) => { throw new Error(`TrackerProvider.${m}: not implemented`); };

export class TrackerProvider {
  name() { return NI('name'); }
  capabilities() { return new Set(); }
  async init(_cwd, _config) { return this; }
  async health() { return { ok: true, provider: this.name?.() ?? 'base', canonical: 'local', pendingOps: 0, conflicts: 0, mixedSources: [] }; }
  async sync() { return { drained: 0, quarantined: 0 }; }
  async getFeature(_code) { return NI('getFeature'); }
  async listFeatures() { return NI('listFeatures'); }
  async createFeature(_code, _obj) { return NI('createFeature'); }
  async putFeature(_code, _obj) { return NI('putFeature'); }
  async persistFeatureRaw(_code, _obj) { return NI('persistFeatureRaw'); }
  async deleteFeature(_code) { return NI('deleteFeature'); }
  async setStatus(_code, _to, _meta) { return NI('setStatus'); }
  async recordCompletion(_code, _rec) { return NI('recordCompletion'); }
  async addRoadmapEntry(_args) { return NI('addRoadmapEntry'); }
  async appendEvent(_code, _event) { return NI('appendEvent'); }
  async readEvents(_code) { return NI('readEvents'); }
  async renderRoadmap() { return NI('renderRoadmap'); }
  async getChangelog() { return NI('getChangelog'); }
  async putChangelog(_text) { return NI('putChangelog'); }
  async appendChangelog(_entry) { return NI('appendChangelog'); }
  async readJournal() { return NI('readJournal'); }
  async writeJournalEntry(_e) { return NI('writeJournalEntry'); }
  async getVisionState() { return NI('getVisionState'); }
  async putVisionState(_s) { return NI('putVisionState'); }
}
