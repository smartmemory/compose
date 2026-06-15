/**
 * FORGE-ROADMAP-RETIRE-STORE — the vision store is retired when a workspace sets
 * `capabilities.lifecycle: false`. loadVisionState() (the single chokepoint behind
 * every MCP vision-read tool) then returns empty, so a narrative-owned workspace
 * cannot surface a second, drift-prone answer beside the prose ROADMAP.
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { switchProject, isLifecycleEnabled, getTargetRoot } =
  await import(`${ROOT}/server/project-root.js`)
const {
  loadVisionState, toolGetVisionItems,
  toolGetItemDetail, toolGetPhasesSummary, toolGetBlockedItems, toolGetPendingGates,
} = await import(`${ROOT}/server/compose-mcp-tools.js`)

const ORIGINAL_ROOT = getTargetRoot()
const made = []

/** Build a temp workspace with the given capabilities + (optional) vision-state items. */
function mkWorkspace({ capabilities, items = [], narrative = false } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'retire-store-'))
  made.push(ws)
  mkdirSync(join(ws, '.compose', 'data'), { recursive: true })
  const cfg = { version: 2 }
  if (capabilities) cfg.capabilities = capabilities
  if (narrative) cfg.roadmap = { narrative: true }
  writeFileSync(join(ws, '.compose', 'compose.json'), JSON.stringify(cfg, null, 2))
  writeFileSync(
    join(ws, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items, connections: [], gates: [] }, null, 2) + '\n',
  )
  return ws
}

const SAMPLE_ITEMS = [
  { id: 'a', type: 'feature', title: 'Alpha', status: 'in_progress', phase: 'implementation' },
  { id: 'b', type: 'feature', title: 'Beta', status: 'complete', phase: 'release' },
]

afterEach(() => {
  switchProject(ORIGINAL_ROOT)
  for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
})

test('isLifecycleEnabled: default true (absent capabilities / absent flag / explicit true)', () => {
  switchProject(mkWorkspace({}))
  assert.equal(isLifecycleEnabled(), true, 'absent capabilities ⇒ enabled')

  switchProject(mkWorkspace({ capabilities: { stratum: true } }))
  assert.equal(isLifecycleEnabled(), true, 'absent lifecycle flag ⇒ enabled')

  switchProject(mkWorkspace({ capabilities: { lifecycle: true } }))
  assert.equal(isLifecycleEnabled(), true, 'explicit true ⇒ enabled')
})

test('isLifecycleEnabled: false only when explicitly disabled', () => {
  switchProject(mkWorkspace({ capabilities: { stratum: true, lifecycle: false }, narrative: true }))
  assert.equal(isLifecycleEnabled(), false)
})

test('loadVisionState: returns the populated store when lifecycle is enabled', () => {
  switchProject(mkWorkspace({ capabilities: { lifecycle: true }, items: SAMPLE_ITEMS }))
  const state = loadVisionState()
  assert.equal(state.items.length, 2, 'enabled store reads its items')
})

test('loadVisionState: RETIRED — returns empty when lifecycle disabled, even with items on disk', () => {
  switchProject(mkWorkspace({ capabilities: { lifecycle: false }, items: SAMPLE_ITEMS }))
  const state = loadVisionState()
  assert.deepEqual(state, { items: [], connections: [], gates: [] },
    'a populated vision-state.json is ignored once the store is retired')
})

test('toolGetVisionItems: returns no items from a retired store', () => {
  switchProject(mkWorkspace({ capabilities: { lifecycle: false }, items: SAMPLE_ITEMS }))
  const res = toolGetVisionItems({})
  assert.equal(res.count, 0)
  assert.equal(res.returned, 0)
  assert.deepEqual(res.items, [])

  // ...and the same query against an enabled store still answers, proving the
  // gate is the only thing suppressing it (not an unrelated filter).
  switchProject(mkWorkspace({ capabilities: { lifecycle: true }, items: SAMPLE_ITEMS }))
  assert.equal(toolGetVisionItems({}).count, 2)
})

test('retirement propagates to every dependent vision-read tool (single chokepoint)', () => {
  // All of these read through loadVisionState(), so gating that one function
  // retires the whole MCP vision surface — not just get_vision_items.
  switchProject(mkWorkspace({ capabilities: { lifecycle: false }, items: SAMPLE_ITEMS }))

  assert.deepEqual(toolGetItemDetail({ id: 'a' }), { error: 'Item not found: a' },
    'item detail: retired store has no items')
  const summary = toolGetPhasesSummary({})
  assert.equal(summary.total, 0, 'phase summary: zero items')
  assert.deepEqual(toolGetBlockedItems(), { count: 0, blocked: [] }, 'blocked items: empty')
  assert.deepEqual(toolGetPendingGates({}), { count: 0, gates: [] }, 'pending gates: empty')

  // Enabled control: the same item IS visible when the store is live.
  switchProject(mkWorkspace({ capabilities: { lifecycle: true }, items: SAMPLE_ITEMS }))
  assert.equal(toolGetItemDetail({ id: 'a' }).title, 'Alpha')
  assert.equal(toolGetPhasesSummary({}).total, 2)
})
