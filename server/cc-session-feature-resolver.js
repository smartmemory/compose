/**
 * CC-session → feature_code resolver — COMP-OBS-BRANCH T2.
 *
 * Forge session ids (`session-<ts>-<hex>` from SessionManager) and Claude Code
 * session uuids live in different namespaces. The only join key is
 * `sessions.json[i].transcriptPath` — its basename is `<cc_session_id>.jsonl`.
 *
 * Resolution tiers (per blueprint §5):
 *   1. Primary  — sessions.json scan, match basename(transcriptPath)
 *   2. Fallback — probe <featureRoot>/<CODE>/sessions/<cc_session_id>.*
 *   3. Unbound  — null (caller skips emission)
 *
 * Results cache per cc_session_id; invalidated on mtime bump of either
 * sessions.json or the matched feature's sessions/ directory.
 */

import fs from 'node:fs';
import path from 'node:path';

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

function loadSessionsJson(sessionsFile) {
  try {
    const raw = fs.readFileSync(sessionsFile, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export class CCSessionFeatureResolver {
  constructor({ sessionsFile, featureRoot }) {
    if (!sessionsFile) throw new Error('sessionsFile required');
    if (!featureRoot) throw new Error('featureRoot required');
    this.sessionsFile = sessionsFile;
    this.featureRoot = featureRoot;
    this._cache = new Map(); // cc_session_id → { feature_code, sessionsMtime, featureDirMtime }
    this._sessionsIndex = null;
    this._sessionsMtime = null;
    this.stats = { unbound_count: 0 };
  }

  _refreshIndex() {
    const mtime = statMtime(this.sessionsFile);
    if (mtime === this._sessionsMtime && this._sessionsIndex) return;
    this._sessionsMtime = mtime;
    const sessions = loadSessionsJson(this.sessionsFile);
    const idx = new Map();
    for (const s of sessions) {
      const tp = s?.transcriptPath;
      if (!tp || !s?.featureCode) continue;
      const base = path.basename(tp);
      const ccId = base.replace(/\.jsonl$/, '');
      if (!idx.has(ccId)) idx.set(ccId, s.featureCode);
    }
    this._sessionsIndex = idx;
    this._cache.clear();
  }

  _fallbackProbe(cc_session_id) {
    let entries;
    try { entries = fs.readdirSync(this.featureRoot, { withFileTypes: true }); }
    catch { return null; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const sessionsDir = path.join(this.featureRoot, ent.name, 'sessions');
      let files;
      try { files = fs.readdirSync(sessionsDir); } catch { continue; }
      if (files.some(f => f.startsWith(cc_session_id + '.'))) {
        return ent.name;
      }
    }
    return null;
  }

  resolve(cc_session_id) {
    if (!cc_session_id) return null;
    this._refreshIndex();

    const cached = this._cache.get(cc_session_id);
    if (cached && cached.sessionsMtime === this._sessionsMtime) {
      if (cached.feature_code == null) return null;
      const curDirMtime = statMtime(path.join(this.featureRoot, cached.feature_code, 'sessions'));
      if (curDirMtime === cached.featureDirMtime) return cached.feature_code;
    }

    let fc = this._sessionsIndex.get(cc_session_id);
    if (!fc) fc = this._fallbackProbe(cc_session_id);

    if (fc) {
      const dirMtime = statMtime(path.join(this.featureRoot, fc, 'sessions'));
      this._cache.set(cc_session_id, {
        feature_code: fc,
        sessionsMtime: this._sessionsMtime,
        featureDirMtime: dirMtime,
      });
      return fc;
    }

    this._cache.set(cc_session_id, {
      feature_code: null,
      sessionsMtime: this._sessionsMtime,
      featureDirMtime: null,
    });
    this.stats.unbound_count++;
    return null;
  }
}
