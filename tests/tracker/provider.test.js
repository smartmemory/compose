import { describe, it, expect } from 'vitest';
import { CAP, TrackerConfigError, TrackerProvider } from '../../lib/tracker/provider.js';

describe('provider module', () => {
  it('exposes the six capability constants', () => {
    expect([...Object.values(CAP)].sort()).toEqual(
      ['CHANGELOG', 'EVENTS', 'FEATURES', 'JOURNAL', 'ROADMAP', 'VISION'].sort());
  });
  it('TrackerConfigError is an Error subclass carrying a code', () => {
    const e = new TrackerConfigError('bad scope', { missingScope: 'project' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('TrackerConfigError');
    expect(e.detail.missingScope).toBe('project');
  });
  it('TrackerProvider base methods throw "not implemented"', async () => {
    const p = new TrackerProvider();
    await expect(p.getFeature('X')).rejects.toThrow(/not implemented/);
  });
});
