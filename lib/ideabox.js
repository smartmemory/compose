/**
 * lib/ideabox.js — Ideabox markdown parser, writer, and mutation helpers.
 *
 * Format reference: SmartMemory ideabox.md canonical format.
 * Each idea is an H4 entry under an H3 cluster inside the ## Ideas section.
 *
 * #### IDEA-N — <title>
 * **Status:** NEW | **Priority:** P1 | **Tags:** `#tag`
 * **Source:** <source text>
 * **Idea:** <description prose>
 * **Maps to:** <optional cross-refs>
 *
 * KILLED ideas end up under ## Killed Ideas with:
 * **Killed:** <date> — <reason>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolvePathValue } from './paths-core.js'

// ---------------------------------------------------------------------------
// Default template
// ---------------------------------------------------------------------------

export const IDEABOX_TEMPLATE = `# Ideabox

**Purpose:** Capture raw ideas before they're ready for the roadmap.

## Conventions
- **ID:** \`IDEA-N\` (sequential, never reuse)
- **Status:** \`NEW\` | \`DISCUSSING\` | \`PROMOTED\` | \`KILLED\`
- **Priority:** \`P0\` (promote now) | \`P1\` (next up) | \`P2\` (backlog) | \`—\` (untriaged)
- **Source:** Where the idea came from
- **Tags:** \`#ux\` \`#core\` \`#distribution\` \`#integration\` \`#research\` \`#infra\`

## Ideas

<!-- Ideas grouped by potential feature cluster -->

## Killed Ideas
`

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

// Matches: #### IDEA-42 — Some Title   (or "- " variant)
const IDEA_HEADING_RE = /^####\s+(IDEA-(\d+))\s+[—–-]+\s+(.+)$/

// The LEGACY (pre-umbrella) dialect: ideas are H3 under arbitrary `## Topic`
// headings, with no `## Ideas` wrapper and no cluster level. Published installs
// upgrading from before COMP-PLAN-IDEA-UNIFY have this shape, so it is the
// dialect the migration path actually meets — see COMP-IDEABOX-MIGRATE-DIALECT,
// where failing to read it destroyed 18 ideas in one command.
const LEGACY_IDEA_HEADING_RE = /^###\s+(IDEA-(\d+))\s+[—–-]+\s+(.+)$/

// An idea heading at EITHER level. A third vintage in the wild is a hybrid: it
// has the modern `## Ideas` wrapper (so it is not the flat dialect) but writes
// both its ideas AND its umbrellas at H3. Those two are still unambiguous —
// an H3 that starts with an `IDEA-N` id is an idea, and any other H3 is an
// umbrella — so the level alone was never what distinguished them.
// Measured 2026-09-06: three projects on this machine are in this dialect
// (books 9 ideas, ScaleMate 2, trustflow 1). Before the guard landed they were
// silently destroyed; with the guard but without this they are refused, which
// is safe but leaves them unable to use the ideabox at all.
const IDEA_HEADING_ANY_RE = /^#{3,4}\s+(IDEA-(\d+))\s+[—–-]+\s+(.+)$/

/**
 * A line SHAPED like an idea declaration, at any heading level.
 *
 * Used only to notice a heading the dialect's own idea pattern could not
 * consume — the "I can see something here and cannot read it" case.
 */
const IDEA_DECL_SHAPE_RE = /^\s*#{1,6}\s+(IDEA-\d+)\b/

/** The bullet form, for a document that uses no idea headings at all. */
const IDEA_BULLET_SHAPE_RE = /^\s*[-*]\s+(IDEA-\d+)\s*[—–:-]/


// Matches a field line: **FieldName:** value  (colon inside bold markers)
const FIELD_RE = /^\*\*([^*:]+):\*\*\s*(.*)$/

// Matches a discussion entry: - [2026-04-10] author: text
//
// The author is "everything up to the first colon", not `\w+`.
//
// COMP-FLUID-SEAM-GUARANTEES F7-1. `\w+` matched no real person's name: an entry
// written by `Jane Doe` rendered correctly into the file and then parsed to
// ZERO discussion entries, silently, taking the comment with it and breaking the
// `serialize(parse(projection))` fixed point the cutover rests on. It was
// unreachable while the CLI was the only writer (it always writes `human`) and
// became reachable the moment the REST API accepted an author from a request
// body (COMP-PLAN-IDEA-UNIFY S3b-2).
//
// Lazy, so the FIRST colon delimits: an author cannot contain one (the contract
// forbids it, since the file could not represent it), while the comment text
// routinely does — `- [2026-08-05] human: see this: it matters` keeps the whole
// sentence.
const DISCUSSION_ENTRY_RE = /^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+([^:\n]+?):\s+(.+)$/

// ---------------------------------------------------------------------------
// parseIdeabox(markdown) → { ideas, killed, nextId }
// ---------------------------------------------------------------------------

/**
 * Parse ideabox markdown into structured data.
 * @param {string} markdown
 * @returns {{ ideas: IdeaEntry[], killed: IdeaEntry[], nextId: number }}
 */
export function parseIdeabox(markdown) {
  const lines = markdown.split('\n')

  // Legacy dialect detection, fenced as narrowly as possible: it activates ONLY
  // when the document has no `## Ideas` section AND carries H3 idea headings.
  // A new-dialect file always opens its ideas with `## Ideas`, so legacy mode
  // can never engage on one. A file with BOTH shapes is deliberately left to
  // the modern path — a half-converted document is not something to guess at,
  // and the migration gate refuses it by declaration count instead.
  // A COMPLETE heading, not a prefix: `/^##\s+Ideas/` also matched a legitimate
  // legacy topic called `## Ideas for Later`, which switched legacy mode off and
  // made that document's ideas unreadable. Fenced blocks are skipped for the
  // same reason — an example containing `## Ideas` must not decide the dialect
  // of the file quoting it.
  const structural = []
  let fenced = false
  for (const l of lines) {
    if (/^\s*```/.test(l)) { fenced = !fenced; continue }
    if (!fenced) structural.push(l)
  }
  const hasIdeasSection = structural.some((l) => /^##\s+Ideas\s*$/.test(l))
  const legacy = !hasIdeasSection && structural.some((l) => LEGACY_IDEA_HEADING_RE.test(l))

  // The hybrid dialect only exists in a document the tools have NEVER written:
  // every write emits ideas at H4, so a document containing any `#### IDEA-` is
  // modern, and an H3 there is an umbrella no matter what it is called.
  //
  // That distinction is load-bearing rather than cosmetic. `compose ideabox`
  // will happily create a cluster named `IDEA-9 — Cache research`, and reading
  // that back as an idea made the next command fail: the guard saw a declared
  // id with no record behind it and refused. Recognising H3 ideas everywhere
  // broke round-tripping the tool's own output.
  const hasModernIdeaHeadings = structural.some((l) => IDEA_HEADING_RE.test(l))
  const hybrid = hasIdeasSection && !hasModernIdeaHeadings
  const ideaHeadingRe = legacy
    ? LEGACY_IDEA_HEADING_RE
    : (hybrid ? IDEA_HEADING_ANY_RE : IDEA_HEADING_RE)

  const ideas = []
  const killed = []
  // Cluster-scoped data. An umbrella heading carries a hand-authored multi-
  // sentence `**Theme:**` paragraph, which is information, not decoration —
  // before this was captured it sat between the H3 and the first H4 where the
  // loop had no `currentIdea`, so it was silently dropped and every
  // parse→serialize cycle (i.e. every `compose ideabox` mutation) deleted it.
  const clusters = []
  const clusterIndex = new Map()
  // Idea-shaped headings that NO branch consumed. The migration gate compares
  // these against the ideas actually produced, so that "the parser could not
  // read this" can never be mistaken for "there was nothing here". Collected
  // HERE, by the parser itself, rather than by a second scanner: the whole class
  // of bug this module keeps producing is two readers disagreeing about what the
  // document says, and a separate scanner is a second reader by construction.
  const shapes = []
  // Idea-shaped headings taken as UMBRELLA names. Legitimate on its own — the
  // tools will create a cluster called `IDEA-9 — Cache research` — but an
  // umbrella named after an id that is ALSO a real idea in the same document is
  // the half-converted file, not a naming choice.
  const clusterNamedIds = []
  // Everything before `## Ideas`. Regenerating this from IDEABOX_TEMPLATE
  // instead of preserving it drops hand-authored convention bullets.
  const preambleLines = []

  // In the legacy dialect there is no `## Ideas` wrapper — the ideas simply
  // live under topic headings — so the whole document is the ideas section.
  let inIdeasSection = legacy
  let inKilledSection = false
  let currentCluster = null
  let currentIdea = null
  let seenAnySection = false

  function flushCurrentIdea() {
    if (!currentIdea) return
    // Remove internal parsing state before pushing
    delete currentIdea._inDiscussion
    if (inKilledSection) {
      killed.push(currentIdea)
    } else {
      ideas.push(currentIdea)
    }
    currentIdea = null
  }

  // Fenced blocks are documentation, not content. Detection and the declaration
  // scan already skipped them; the parse loop did not, so an example in a
  // ```markdown``` block was imported as a real idea — and, worse, satisfied the
  // readability guard on behalf of a genuine entry with the same id that the
  // parser could NOT read, letting the destructive write through. All three
  // readers have to agree on what is content.
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/^\s*```/.test(line)) {
      inFence = !inFence
      if (!inIdeasSection && !inKilledSection && !seenAnySection) preambleLines.push(line)
      // The DELIMITERS are content too. Keeping the enclosed lines while
      // dropping the fence turned a fenced `#### IDEA-2 — example` inside an
      // idea's body into a real heading on the next projection, and the render
      // after that refused the file it had just written.
      else if (currentIdea) currentIdea._extraLines.push(line)
      continue
    }
    if (inFence) {
      if (!inIdeasSection && !inKilledSection && !seenAnySection) preambleLines.push(line)
      else if (currentIdea) currentIdea._extraLines.push(line)
      continue
    }

    // Every idea-shaped heading in the document, recorded BEFORE any branch can
    // swallow it. What is consumed as a real idea or as an umbrella is
    // subtracted at the end; whatever is left is content the parser could see
    // and could not read, which the migration gate must refuse rather than
    // treat as absent.
    const shapeHere = line.match(IDEA_DECL_SHAPE_RE)
    if (shapeHere) shapes.push(shapeHere[1])

    // Detect section boundaries
    if (/^##\s+Ideas\s*$/.test(line)) {
      flushCurrentIdea()
      inIdeasSection = true
      inKilledSection = false
      seenAnySection = true
      currentCluster = null
      continue
    }
    if (/^##\s+Killed\s+Ideas\s*$/.test(line)) {
      flushCurrentIdea()
      inIdeasSection = false
      inKilledSection = true
      seenAnySection = true
      currentCluster = null
      continue
    }
    // Other H2 sections end both
    if (/^##\s/.test(line) && !(/^##\s+Ideas\s*$/.test(line)) && !(/^##\s+Killed\s+Ideas\s*$/.test(line))) {
      flushCurrentIdea()
      if (legacy) {
        // A `## Topic` heading in the legacy dialect is not the end of the
        // ideas — it is how that dialect GROUPED them, which is precisely what
        // an umbrella is. Mapping it to a cluster instead of discarding it
        // means the upgrade preserves the author's grouping rather than
        // flattening ten topics into one undifferentiated list. Treating it as
        // preamble (the previous behaviour) collected every topic heading at
        // the top of the file, detached from its ideas.
        const name = line.replace(/^##\s+/, '').trim()
        seenAnySection = true
        // Leaving the killed section matters: without this, every idea under a
        // topic heading that happened to follow `## Killed Ideas` was imported
        // as KILLED. A topic heading opens a group, it does not inherit the
        // previous section's disposition — and it re-enters the ideas section,
        // which `## Killed Ideas` had closed, or the ideas below it are read as
        // neither live nor killed and vanish entirely.
        inKilledSection = false
        inIdeasSection = true
        currentCluster = name
        if (!clusterIndex.has(name)) {
          const entry = { name, theme: '', order: clusters.length }
          clusters.push(entry)
          clusterIndex.set(name, entry)
        }
        continue
      }
      inIdeasSection = false
      inKilledSection = false
      // Still part of the preamble when it precedes the first real section —
      // `## Conventions` lives here and was being dropped on the floor.
      if (!seenAnySection) preambleLines.push(line)
      continue
    }

    // Legacy preamble: everything before the first topic heading or idea. The
    // modern collector below is unreachable here because legacy mode is inside
    // the ideas section from line one, so without this the document's title and
    // introduction were dropped on the first render after migration.
    if (legacy && !seenAnySection && !currentIdea) {
      preambleLines.push(line)
      continue
    }

    if (!inIdeasSection && !inKilledSection) {
      // Preamble = everything before the first section heading.
      if (!seenAnySection) preambleLines.push(line)
      continue
    }

    // Horizontal rules inside the ideas section are structural separators
    // between umbrellas. They are regenerated by the serializer from the
    // cluster list, so capturing them here would attach each one to the
    // PRECEDING idea's extra lines and duplicate every rule on write.
    if (/^---\s*$/.test(line)) {
      continue
    }

    // H3 = cluster heading (modern dialect only — in the legacy dialect H3 IS
    // the idea heading, handled below, and there is no cluster level at all).
    // An H3 carrying an idea id is an IDEA at this level too, not an umbrella
    // named after one; the hybrid dialect writes both at H3.
    if (!legacy && /^###\s/.test(line) && !(hybrid && IDEA_HEADING_ANY_RE.test(line))) {
      flushCurrentIdea()
      const eaten = line.match(IDEA_DECL_SHAPE_RE)
      if (eaten) clusterNamedIds.push(eaten[1])
      currentCluster = line.replace(/^###\s+/, '').trim()
      if (!clusterIndex.has(currentCluster)) {
        const entry = { name: currentCluster, theme: '', order: clusters.length }
        clusters.push(entry)
        clusterIndex.set(currentCluster, entry)
      }
      continue
    }

    // Cluster-scoped `**Theme:**` paragraph — appears after the H3 and before
    // the first H4, i.e. exactly where there is no current idea to attach it to.
    if (currentCluster && !currentIdea) {
      const themeMatch = line.match(/^\*\*Theme:\*\*\s*(.*)$/)
      if (themeMatch) {
        clusterIndex.get(currentCluster).theme = themeMatch[1].trim()
        continue
      }
    }

    // H4 = idea heading
    const headingMatch = line.match(ideaHeadingRe)
    if (headingMatch) {
      flushCurrentIdea()
      currentIdea = {
        id: headingMatch[1],            // "IDEA-42"
        num: parseInt(headingMatch[2], 10),
        title: headingMatch[3].trim(),
        status: 'NEW',
        priority: '—',
        tags: [],
        source: '',
        description: '',
        cluster: currentCluster || null,
        mapsTo: '',
        killedReason: '',
        killedDate: '',
        effort: null,
        impact: null,
        discussion: [],
        // raw fields for round-trip fidelity
        _extraLines: [],
        _inDiscussion: false,
      }
      continue
    }

    if (!currentIdea) continue

    // Discussion header line: **Discussion:**  (must check before general FIELD_RE)
    if (line.trim() === '**Discussion:**') {
      currentIdea._inDiscussion = true
      continue
    }

    // Field lines
    const fieldMatch = line.match(FIELD_RE)
    if (fieldMatch) {
      const key = fieldMatch[1].trim()
      const val = fieldMatch[2].trim()

      if (key === 'Status') {
        // Handle inline: "NEW | **Priority:** P1 | **Tags:** `#tag`"
        // or just: "PROMOTED (→ FEAT-1)"
        // Split on | to get multiple fields on one line
        const parts = val.split('|').map(p => p.trim())
        for (const part of parts) {
          const inlineField = part.match(FIELD_RE)
          if (inlineField) {
            applyField(currentIdea, inlineField[1].trim(), inlineField[2].trim())
          } else {
            // The status itself
            currentIdea.status = extractStatus(part)
          }
        }
      } else {
        applyField(currentIdea, key, val)
      }
      continue
    }

    // Discussion entry: - [date] author: text
    if (currentIdea._inDiscussion) {
      const discMatch = line.match(DISCUSSION_ENTRY_RE)
      if (discMatch) {
        currentIdea.discussion.push({
          date: discMatch[1],
          author: discMatch[2],
          text: discMatch[3].trim(),
        })
        continue
      }
      // Empty line in discussion block — stay in discussion mode
      if (!line.trim()) continue
      // Non-matching non-empty line → exit discussion mode, fall through
      currentIdea._inDiscussion = false
    }

    // Non-empty lines after the heading = extra content (description overflow, etc.)
    if (line.trim()) {
      currentIdea._extraLines.push(line)
    }
  }

  flushCurrentIdea()

  // Compute nextId
  const allNums = [...ideas, ...killed].map(i => i.num).filter(n => !isNaN(n))
  const maxNum = allNums.length ? Math.max(...allNums) : 0
  const nextId = maxNum + 1

  // Trailing blank lines before `## Ideas` are structural, not content — the
  // serializer re-adds the separator itself.
  while (preambleLines.length && preambleLines.at(-1).trim() === '') preambleLines.pop()

  // The bullet form is a fallback, not a rule: it counts ONLY for a document
  // with no idea headings whatsoever. Counting bullets unconditionally made
  // `- IDEA-1 needs research`, written inside IDEA-1's own body, a second
  // declaration of IDEA-1 — and the gate then refused a perfectly readable file.
  // A reference is not a declaration, and the only document where a bullet
  // plausibly IS one is a document that declares nothing any other way.
  const parsedIds = [...ideas, ...killed].map((i) => i.id)

  // By COUNT, not by membership. A half-converted document declares the same id
  // twice — once in each dialect — and the parser consumes only one of them; a
  // membership test sees the id in `parsedIds` and calls it accounted for, while
  // the other copy (routinely the older, richer one) is invisible and would be
  // deleted by the next render. Counting says two were written and one was read.
  const count = (arr, id) => arr.filter((x) => x === id).length
  const unconsumed = [...new Set(shapes)].filter(
    (id) => count(shapes, id) > count(parsedIds, id) + count(clusterNamedIds, id),
  )
  // An umbrella named after an id that is also a real idea here.
  const collisions = clusterNamedIds.filter((id) => parsedIds.includes(id))

  if (!ideas.length && !killed.length && !unconsumed.length) {
    let bulletFence = false
    for (const line of lines) {
      if (/^\s*```/.test(line)) { bulletFence = !bulletFence; continue }
      if (bulletFence) continue
      const m = line.match(IDEA_BULLET_SHAPE_RE)
      if (m && !unconsumed.includes(m[1])) unconsumed.push(m[1])
    }
  }

  return {
    ideas,
    killed,
    nextId,
    clusters,
    preamble: preambleLines.join('\n'),
    // Idea-shaped content this parse could NOT turn into an idea.
    unconsumed,
    // Umbrellas named after ids that are also real ideas in this document.
    collisions,
  }
}

function extractStatus(raw) {
  const val = raw.toUpperCase()
  if (val.startsWith('NEW')) return 'NEW'
  if (val.startsWith('DISCUSSING')) return 'DISCUSSING'
  if (val.startsWith('PROMOTED')) return raw // preserve "(→ FEAT-1)" suffix
  if (val.startsWith('KILLED')) return 'KILLED'
  return raw.trim()
}

function applyField(idea, key, val) {
  switch (key) {
    case 'Status':
      idea.status = extractStatus(val)
      break
    case 'Priority':
      idea.priority = val.replace(/`/g, '').trim() || '—'
      break
    case 'Tags':
      // Accepts BOTH spellings. The documented convention is `` `#ux` ``, but
      // the real ideabox writes bare words (`stratum integrity research-
      // influence`), and the old `/#\w+/g` matched none of them — so all 20
      // ideas parsed with zero tags and every CLI mutation stripped the lot.
      // Tokens are kept verbatim (a leading `#` is preserved, never added) so
      // whichever spelling a file uses survives a round-trip unchanged.
      idea.tags = val
        .replace(/`/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
      break
    case 'Source':
      idea.source = val
      break
    case 'Idea':
      idea.description = val
      break
    case 'Maps to':
    case 'Maps To':
      idea.mapsTo = val
      break
    case 'Effort':
      // Validate: only S/M/L allowed, anything else becomes null
      idea.effort = ['S', 'M', 'L'].includes(val) ? val : null
      break
    case 'Impact':
      // Validate: only low/medium/high allowed
      idea.impact = ['low', 'medium', 'high'].includes(val) ? val : null
      break
    case 'Killed':
      // "2026-04-09 — reason text"
      {
        const m = val.match(/^(\S+)\s+[—–-]+\s+(.+)$/)
        if (m) {
          idea.killedDate = m[1]
          idea.killedReason = m[2]
        } else {
          idea.killedReason = val
        }
        idea.status = 'KILLED'
      }
      break
    default:
      // Store unknown fields in extra lines for round-trip
      idea._extraLines.push(`**${key}:** ${val}`)
  }
}

// ---------------------------------------------------------------------------
// serializeIdeabox(parsedData) → markdown string
// ---------------------------------------------------------------------------

/**
 * Serialize parsed ideabox data back to markdown.
 * @param {{ ideas: IdeaEntry[], killed: IdeaEntry[], nextId: number }} parsedData
 * @returns {string}
 */
export function serializeIdeabox({ ideas, killed, clusters: clusterMeta = [], preamble = '' }) {
  const lines = []

  if (preamble) {
    // Round-trip the author's own preamble. Regenerating it from the template
    // silently deletes any convention the project added (the real ideabox
    // documents an `**Umbrella:**` rule the template has never known about).
    lines.push(...preamble.split('\n'))
    lines.push('')
  } else {
    lines.push('# Ideabox')
    lines.push('')
    lines.push('**Purpose:** Capture raw ideas before they\'re ready for the roadmap.')
    lines.push('')
    lines.push('## Conventions')
    lines.push('- **ID:** `IDEA-N` (sequential, never reuse)')
    lines.push('- **Status:** `NEW` | `DISCUSSING` | `PROMOTED` | `KILLED`')
    lines.push('- **Priority:** `P0` (promote now) | `P1` (next up) | `P2` (backlog) | `—` (untriaged)')
    lines.push('- **Source:** Where the idea came from')
    lines.push('- **Tags:** `#ux` `#core` `#distribution` `#integration` `#research` `#infra`')
    lines.push('')
  }
  lines.push('## Ideas')
  lines.push('')
  if (!clusterMeta.length) {
    lines.push('<!-- Ideas grouped by potential feature cluster -->')
    lines.push('')
  }

  // Group active ideas by cluster
  const clusters = new Map()
  const unclustered = []
  // Seed in declared cluster order so an empty cluster keeps its place and its
  // theme rather than disappearing.
  for (const c of clusterMeta) clusters.set(c.name, [])
  const themeOf = new Map(clusterMeta.map((c) => [c.name, c.theme]))
  for (const idea of ideas) {
    if (idea.cluster) {
      if (!clusters.has(idea.cluster)) clusters.set(idea.cluster, [])
      clusters.get(idea.cluster).push(idea)
    } else {
      unclustered.push(idea)
    }
  }

  for (const [cluster, clusterIdeas] of clusters) {
    if (clusterMeta.length) {
      lines.push('---')
      lines.push('')
    }
    lines.push(`### ${cluster}`)
    lines.push('')
    const theme = themeOf.get(cluster)
    if (theme) {
      lines.push(`**Theme:** ${theme}`)
      lines.push('')
    }
    for (const idea of clusterIdeas) {
      lines.push(...serializeIdea(idea))
    }
  }

  if (unclustered.length > 0) {
    for (const idea of unclustered) {
      lines.push(...serializeIdea(idea))
    }
  }

  lines.push('## Killed Ideas')
  lines.push('')

  for (const idea of killed) {
    lines.push(...serializeKilledIdea(idea))
  }

  return lines.join('\n')
}

function serializeIdea(idea) {
  const out = []
  out.push(`#### ${idea.id} — ${idea.title}`)

  // Build status line
  const tagStr = idea.tags.length ? ` | **Tags:** ${idea.tags.join(' ')}` : ''
  const statusStr = idea.status.startsWith('PROMOTED')
    ? idea.status
    : idea.status
  out.push(`**Status:** ${statusStr} | **Priority:** ${idea.priority}${tagStr}`)

  if (idea.source) out.push(`**Source:** ${idea.source}`)
  if (idea.description) out.push(`**Idea:** ${idea.description}`)

  // Unrecognized field lines are emitted here, BEFORE the trailing known
  // fields, because that is where they occur in practice: an idea that carries
  // custom `**Idea (original):**` / `**Re-aim:**` blocks ends with `**Maps
  // to:**`, and emitting extras last reordered the file on every write.
  for (const extra of (idea._extraLines || [])) {
    out.push(extra)
  }

  if (idea.mapsTo) out.push(`**Maps to:** ${idea.mapsTo}`)
  if (idea.effort) out.push(`**Effort:** ${idea.effort}`)
  if (idea.impact) out.push(`**Impact:** ${idea.impact}`)

  // Discussion thread
  if (idea.discussion && idea.discussion.length > 0) {
    out.push('**Discussion:**')
    for (const entry of idea.discussion) {
      out.push(`- [${entry.date}] ${entry.author}: ${entry.text}`)
    }
  }

  out.push('')
  return out
}

function serializeKilledIdea(idea) {
  const out = []
  out.push(`#### ${idea.id} — ${idea.title}`)

  const tagStr = idea.tags.length ? ` | **Tags:** ${idea.tags.join(' ')}` : ''
  out.push(`**Status:** KILLED${tagStr}`)

  if (idea.source) out.push(`**Source:** ${idea.source}`)
  if (idea.description) out.push(`**Idea:** ${idea.description}`)
  if (idea.mapsTo) out.push(`**Maps to:** ${idea.mapsTo}`)
  if (idea.effort) out.push(`**Effort:** ${idea.effort}`)
  if (idea.impact) out.push(`**Impact:** ${idea.impact}`)

  const date = idea.killedDate || new Date().toISOString().slice(0, 10)
  const reason = idea.killedReason || '(no reason given)'
  out.push(`**Killed:** ${date} — ${reason}`)

  for (const extra of (idea._extraLines || [])) {
    out.push(extra)
  }

  // Discussion thread
  if (idea.discussion && idea.discussion.length > 0) {
    out.push('**Discussion:**')
    for (const entry of idea.discussion) {
      out.push(`- [${entry.date}] ${entry.author}: ${entry.text}`)
    }
  }

  out.push('')
  return out
}

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

/**
 * Add a new idea. Mutates parsedData in place and returns it.
 */
export function addIdea(parsedData, { title, description = '', source = '', tags = [], cluster = null, effort = null, impact = null }) {
  const id = `IDEA-${parsedData.nextId}`
  const idea = {
    id,
    num: parsedData.nextId,
    title,
    status: 'NEW',
    priority: '—',
    tags: Array.isArray(tags) ? tags : [],
    source,
    description,
    cluster: cluster || null,
    mapsTo: '',
    killedReason: '',
    killedDate: '',
    effort,
    impact,
    discussion: [],
    _extraLines: [],
  }
  parsedData.ideas.push(idea)
  parsedData.nextId += 1
  return parsedData
}

/**
 * Promote an idea: mark PROMOTED, optionally reference a feature code.
 */
export function promoteIdea(parsedData, ideaId, featureCode = '') {
  const idea = findIdea(parsedData, ideaId)
  if (!idea) throw new Error(`Idea not found: ${ideaId}`)
  const ref = featureCode ? ` (→ ${featureCode})` : ''
  idea.status = `PROMOTED${ref}`
  return parsedData
}

/**
 * Kill an idea: move from ideas → killed with reason + date.
 */
export function killIdea(parsedData, ideaId, reason = '') {
  const idx = parsedData.ideas.findIndex(i => i.id.toUpperCase() === ideaId.toUpperCase())
  if (idx === -1) {
    // Already in killed? No-op.
    const inKilled = parsedData.killed.find(i => i.id.toUpperCase() === ideaId.toUpperCase())
    if (inKilled) return parsedData
    throw new Error(`Idea not found: ${ideaId}`)
  }
  const [idea] = parsedData.ideas.splice(idx, 1)
  idea.status = 'KILLED'
  idea.killedReason = reason
  idea.killedDate = new Date().toISOString().slice(0, 10)
  parsedData.killed.push(idea)
  return parsedData
}

/**
 * Resurrect a killed idea: move from killed → ideas, reset status to NEW.
 */
export function resurrectIdea(parsedData, ideaId) {
  const idx = parsedData.killed.findIndex(i => i.id.toUpperCase() === ideaId.toUpperCase())
  if (idx === -1) throw new Error(`Killed idea not found: ${ideaId}`)
  const [idea] = parsedData.killed.splice(idx, 1)
  idea.status = 'NEW'
  delete idea.killedReason
  delete idea.killedDate
  parsedData.ideas.push(idea)
  return parsedData
}

/**
 * Set priority on an idea.
 */
export function setPriority(parsedData, ideaId, priority) {
  const valid = ['P0', 'P1', 'P2', '—']
  if (!valid.includes(priority)) throw new Error(`Invalid priority: ${priority}. Must be P0, P1, P2, or —`)
  const idea = findIdea(parsedData, ideaId)
  if (!idea) throw new Error(`Idea not found: ${ideaId}`)
  idea.priority = priority
  return parsedData
}

/**
 * Update arbitrary fields on an idea (status, source, description, tags, cluster).
 */
export function updateIdea(parsedData, ideaId, fields) {
  const idea = findIdea(parsedData, ideaId)
  if (!idea) throw new Error(`Idea not found: ${ideaId}`)
  Object.assign(idea, fields)
  return parsedData
}

/**
 * Append a discussion entry to an idea.
 * @param {object} parsedData
 * @param {string} ideaId     e.g. "IDEA-3"
 * @param {string} author     e.g. "human" or "agent"
 * @param {string} text       Comment text
 */
export function addDiscussion(parsedData, ideaId, author, text) {
  const idea = findIdea(parsedData, ideaId)
  if (!idea) throw new Error(`Idea not found: ${ideaId}`)
  if (!idea.discussion) idea.discussion = []
  idea.discussion.push({
    date: new Date().toISOString().slice(0, 10),
    author,
    text,
  })
  return parsedData
}

// ---------------------------------------------------------------------------
// Lens support (Item 180)
// ---------------------------------------------------------------------------

/**
 * Load a priority lens from docs/product/ideabox-priority-<lensName>.md.
 * Returns lens metadata or null if not found.
 */
export function loadLens(cwd, lensName) {
  const lensPath = join(cwd, 'docs', 'product', `ideabox-priority-${lensName}.md`)
  if (!existsSync(lensPath)) return null
  const content = readFileSync(lensPath, 'utf-8')
  return { name: lensName, path: lensPath, content }
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse the ideabox file from the project.
 */
export function readIdeabox(cwd, ideaboxPath) {
  const fullPath = resolvePathValue(cwd, ideaboxPath, 'ideabox')
  if (!existsSync(fullPath)) {
    // Return empty state
    return { ideas: [], killed: [], nextId: 1 }
  }
  const markdown = readFileSync(fullPath, 'utf-8')
  return parseIdeabox(markdown)
}

/**
 * Write serialized ideabox back to disk.
 */
export function writeIdeabox(cwd, ideaboxPath, parsedData) {
  const fullPath = resolvePathValue(cwd, ideaboxPath, 'ideabox')
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, serializeIdeabox(parsedData))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findIdea(parsedData, ideaId) {
  const upper = ideaId.toUpperCase()
  return parsedData.ideas.find(i => i.id.toUpperCase() === upper)
    || parsedData.killed.find(i => i.id.toUpperCase() === upper)
    || null
}
