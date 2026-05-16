import { readFeature, listFeatures as listFeaturesRaw, writeFeature } from '../feature-json.js';
import { loadFeaturesDir } from '../project-paths.js';
import { TrackerProvider, CAP } from './provider.js';

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

  // Stub: returns empty array so createFeature conformance test (which calls readEvents) passes.
  // Full implementation in Task 4.
  async readEvents(_code) {
    return [];
  }
}
