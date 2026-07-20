# COMP-FOH — Front of House: Maya + SmartMemory as Compose's Memory & Colleague Layer

**Status:** PLANNED (design/strategy — not scoped to slices yet)
**Epic:** COMP-FOH
**Date:** 2026-07-20

## Related Documents

- North-star: [The Discovery Loop vision](../../product/2026-07-20-discovery-loop-vision.md) — this is the substrate that makes the loop real.
- Sibling near-term: [Front-of-Funnel Rigor + Parity](../../design/2026-07-20-front-funnel-rigor-design.md) (COMP-PLAN-RIGOR).
- Maya: `/Users/ruze/reg/my/SmartMemory/maya/CLAUDE.md`
- SmartMemory architecture: `/Users/ruze/reg/my/SmartMemory/CLAUDE.md` (typed memory OS: FalkorDB graph + vector, 11-stage pipeline, evolvers, structured handlers, SecureSmartMemory tenancy).
- Reconciles: COMP-ROADMAP Decision 2 (canon native, no vendor in core) — clarified, not violated (see Canon below).

## The organizing metaphor: Front of House / Back of House

The whole system is a restaurant.

- **You (CEO)** — the owner. Set direction, hold the vision, make the calls.
- **Front of House = Maya + SmartMemory.** Maya is the maître d' / right-hand exec (COO/CTO/CMO) you actually talk to; SmartMemory is her memory of you, of herself, and of the conversation. This is where the *fluid* work lives: framing, ideation, deliberation, conviction, challenge, the relationship. It is the experience of the product.
- **Back of House = Compose delivery + git canon.** The kitchen you never see: the plan→build→ship lifecycle, the git-committed `feature.json`/roadmap. Runs off order tickets.
- **The order ticket = promotion.** "Deciding to build X" is the ticket printing in the kitchen: a matured idea **crystallizes** from the fluid front-of-house memory into a committed `feature.json`. When the dish ships, the exhaust (what worked, what died) **dissolves back** into front-of-house memory as learning. That cycle is the Discovery Loop.

Maya's autonomy (drive vs. follow) is Compose's existing **gate/flag/skip dial** pointed at initiative — the same primitive, not a new one. Front of house can be as hands-on or as delegated as the owner sets, per decision.

## Maya's hats (general + specialized, via a promotion ladder)

Maya is both a general exec assistant and a specialized goal-to-product colleague — resolved by *where* the "both" lives:

- **Shared core (one brain):** memory, profiling, challenge, proactivity, worldview — domain-agnostic, drawn from the same engine (today: 14 pluggable mixins over one SmartMemory adapter).
- **Additive skill-packs (hats):** a "hat" = persona/voice + skill selection + tools + autonomy default. "Product strategist" is a hat *added* to the core, never a fork of it. Specialization MUST be additive — if it requires changing the core, it is a fork, not a hat.
- **Distinct interaction modes:** hats are worn one at a time, entered deliberately — never blended (a general-assistant voice and a relentless-strategist voice blended = mediocre at both). Same brain, different room.

**Hats are a strict pantry, freely combined, with promotion:**

- *Strict set of primitives* (ingredients): core capabilities/tools/ontology types are governed and tested — never conjured mid-conversation.
- *Dynamic composition* (recipes): Maya can spin up a **provisional** hat on demand by composing existing primitives for a novel situation.
- *Promotion*: a provisional hat that keeps proving useful is named, tuned, tested, and promoted into the durable catalog — reusing SmartMemory's own `provisional → promote` ontology mechanism; the calibration rung (`EvaluationEvolver`) scores which hats deserve promotion.
- *Dial-governed autonomy*: a freshly spun-up hat starts in **gate** (proposes, owner approves) and graduates to flag/skip as it earns trust — improvisation is open-ended, but a novel role never drives unsupervised until proven.

Bonus: the general core is the cold-start intelligence the specialist needs — the general hat already knows the user, which the strategist hat inherits on day one.

## What SmartMemory actually is

A **typed memory operating system**, canon-capable — not a recall sidecar. Decisive tell: an `INDEXED` ingestion strategy stores typed entities with **no embedding** (records queried by field/relation, i.e. source-of-truth), with the associative layer (embeddings, activation-spreading, multi-hop recall) on top. It is both a canonical typed store and an associative index.

## The Discovery Loop is ~80% already built inside SmartMemory

| Loop / Compose concept | SmartMemory primitive (exists today) |
|---|---|
| Idea | `opinion`/`observation`, or custom `idea` entity (structured handler + ontology); `FULL` = recallable |
| Decision card | `decision` type + `add_decision`/`supersede_decision`/`get_active_decisions`; bi-temporal supersession; causal chains |
| Deliberation (question/thread) | `reasoning` type; `create_pending_decision`; proof trees; `route_query` |
| Feature / roadmap item | custom entity via structured handler, `INDEXED` = canonical + field-queryable; `plan`/`plan_task` are working templates |
| Build exhaust | `code`/`code_provenance`/`session`/`evaluation` types; 11-stage ingest; origin-tier provenance |
| **Conviction score** (rung 3) | retention/decay evolvers; retrieval-based strengthening; Hebbian co-retrieval boost |
| **Adversary / challenge** (rung 4) | `challenge_assertion` **first-class facade**; contradiction/grounding stages; decision evolver contradict/retract |
| **Self-grading / calibration** (rung 6) | `EvaluationEvolver`: per-(agent, dimension, domain) scores via bi-temporal supersession — the calibration rung, prebuilt |
| Colleague worldview / thesis | `opinion` type + opinion evolvers + Maya self-reflection evolver |
| Learning from conversation turns | `ConversationContext` + `turn_history` + `ingest_conversation` |
| Interactive real-time surface | workspace-scoped SSE progress bus |

The two hardest rungs (calibration, adversary) are already primitives. That is the case for integrating deep rather than bolting on.

## Two slices of one fabric: front-of-house vs kitchen memory

Both houses use SmartMemory, but different *slices* — it is one memory OS, not two systems.

| | Front of house (Maya) | Kitchen (build agents / chefs) |
|---|---|---|
| Memory answers | "What should we build? Does the user like it? Why?" | "How do we build it well? What broke last time?" |
| Kind | Strategic / relational | Procedural / execution |
| SmartMemory types | opinion, decision, reasoning, observation, episodic, semantic | procedural, plan/plan_task, tool_call, code/code_provenance, evaluation, anchors |
| Concretely | user profile, deliberation, conviction, worldview | how-we-build-here, the failure journal, reusable procedures, which agent excels at what |

SmartMemory already ships the chef-memory machinery: the **procedure matcher (CFS-2)** reuses stored procedural memory instead of re-deriving it (the chef remembers the recipe); **per-agent calibration** (`EvaluationEvolver`) routes the right chef to the right dish. Compose already hand-built a proto of this — the COMP-FIX-HARD hypothesis ledger ("previously rejected" theories) is a chef's failure memory wanting to *be* SmartMemory procedural memory.

**The two slices connect via the loop:** the kitchen's execution memory (what broke, what worked) is exactly the exhaust that **dissolves back** to feed front-of-house conviction and calibration ("we keep failing at X — maybe stop building more X"). Kitchen memory is the fuel for the maître d's strategic memory.

## Scope topology

SmartMemory scopes by **workspace = hard container isolation** (tenant ⊃ workspace ⊃ user), plus a personal-items-follow-user OR-clause, plus "team" as a soft grouping that can *act as* a workspace.

- **Each product → its own workspace** (ideas, decisions, features, exhaust). Isolated.
- **You (CEO) → user scope**; personal items follow you across workspaces.
- **Maya-self → an `is_system` team-as-workspace, per user** — exactly MAYA-SELF-1, already shipped.
- **Portfolio ("one brain across products") → NOT native.** No cross-workspace query or rollup. This rung is build-above. Biggest gap.

## Integration levels (SmartMemory exposes 8, via 5 transports)

Raw item R/W → structured typed-entity (canon) → full ingest pipeline → conversational turn → query/recall → graph/ontology management → lifecycle/evolution → real-time SSE. Transports: in-proc `SmartMemory`; tenant-safe `SecureSmartMemory`; REST service; `SmartMemoryClient` (Py) / `sdk-js`; MCP server. Maya integrates today at the HTTP-client level (14 mixins, is_system self-team, `X-Workspace-Id`-scoped adapter).

## Canon resolution (hybrid — Decision 2 clarified)

- **Fluid → SmartMemory** (front of house): ideas, deliberation, conviction, challenge, calibration, exhaust, the colleague's worldview, conversational learning. Workspace-per-product. All 8 levels live here.
- **Committed → git `feature.json`** (back of house): the promoted feature + roadmap stay git-native — diffable, PR-reviewable, offline. A signed-off record of *what you agreed to build* is a real asset.
- **Execution memory → SmartMemory** (the kitchen's procedural slice): how-we-build, failures, procedures, per-agent calibration. Not git canon — it is *learning*, not commitment. Feeds front-of-house via the dissolution step.
- **Promotion = crystallization** (fluid → committed); **completion = dissolution** (exhaust → fluid learning).

This does not violate Decision 2 — Decision 2's "native canon" was the *committed roadmap*, which stays native. SmartMemory owns the pre-commitment fabric and the post-commitment learning, neither of which `feature.json` was ever good at. Two states of the same matter, not competing canons.

## The 3 things SmartMemory will NOT give you (build-above or accept)

1. **Cross-workspace / portfolio** — no native cross-product query/rollup (the "one brain" rung).
2. **Rich relational / aggregate queries** — Cypher + typed indexes, not SQL/GraphQL.
3. **ACID transactions** — graph + Redis-lock semantics, not an RDBMS.

Only #1 is load-bearing for the Discovery Loop.

## Resolved decisions (2026-07-20)

- **Maya specialize vs general → BOTH.** Shared domain-agnostic core + additive skill-pack "hats" + distinct interaction modes + a `provisional → promote` hat ladder (see Maya's hats above). One brain, many hats, worn one at a time.
- **Coupling posture → opt-in at the front-of-house boundary, all-in inside it.** The kitchen runs headless — no memory required (the portable/CI floor) — and draws the *procedural* slice when memory is present. Front of house (colleague + loop) is the opt-in unit; once enabled it *requires* SmartMemory (no degraded half-memory colleague — a maître d' with amnesia is not a maître d'). Core/kitchen imports no vendor (Decision 2 preserved); the front-of-house module depends on SmartMemory as its substrate.

## Open questions (build-time)

1. Portfolio layer: build cross-workspace rollup above SmartMemory, or model portfolio as its own tenant/workspace with references down?
2. Custom entity types (idea/feature/roadmap-item) as structured handlers + ontology overlays: `INDEXED` (canon, field-queryable) vs `FULL` (also recallable) per type.
3. Transport for Compose↔SmartMemory: HTTP client (like Maya) vs MCP vs in-proc — and where the git-crystal boundary is enforced.
4. Hat catalog v1: which durable hats ship first (strategist, general-assistant, …) and the promotion-criteria threshold.

## Sequencing (minimal-first, not yet sliced)

Rung 1 of COMP-PLAN-RIGOR (unify ideation storage) is the natural first crystallization point — that is where "ideas as first-class items" wants a real store, and SmartMemory is that store. The specialize-vs-general and coupling forks are now resolved (see Resolved decisions); the remaining gates to slicing are the portfolio-layer and transport questions.
