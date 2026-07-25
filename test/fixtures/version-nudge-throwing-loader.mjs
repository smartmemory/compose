const versionCheckUrl = new URL('../../lib/version-check.js', import.meta.url).href;

export async function load(url, context, nextLoad) {
  if (url === versionCheckUrl) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export async function checkLatestVersion() { return null }
        export async function checkPackageVersion() { return null }
        export function resolveStratumVersion() {
          throw new Error('nudge test injected resolver failure')
        }
        export function formatDriftNudge() { return [] }
      `,
    };
  }
  return nextLoad(url, context);
}
