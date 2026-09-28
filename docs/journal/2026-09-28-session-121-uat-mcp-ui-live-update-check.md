---
date: 2026-09-28
session_number: 121
slug: uat-mcp-ui-live-update-check
summary: "UAT pass on the Compose UI: project-switch isolation audit, ideabox stale-state fix, and a demo runbook."
---

# Session 121 — UAT pass on the Compose UI

**Date:** 2026-09-28

## What happened

UAT pass on the Compose UI on 2026-09-28. Switching the target project from compose to a blank testapp left the sidebar showing the previous project's untriaged idea count, which raised the question of whether project data was leaking. It was not: the server re-scoped correctly and the stale count was client-side only. This journal entry was written from the compose MCP as a live test of whether an MCP write reaches the running UI without a page reload.

## What we built

Fix 31e9363: resetForProject on the ideabox store, called from handleProjectSwitch after the workspace-id refresh, clearing ideas, killed, clusters, selection and filters and rehydrating for the new project. A generation counter guards hydrate so a late response from the previous project cannot overwrite the new one. Adds clusters to the store, which the API returned but the store never held. Also wrote docs/demo-runbook.md, a cold-start runbook from empty folder to approved gate.

## What we learned

Server-side isolation is sound by design and was verified empirically: thirteen read endpoints probed against a blank target returned no cross-project data. WorkspaceRuntime keeps per-project stores and routers, pins requests with AsyncLocalStorage, and tears down watchers and sockets on switch. Auth is the exception and sits outside that design. Workspace discovery anchors on the directory the session started in, so a session started in forge cannot reach testapp via MCP even after compose init. Two CLI traps: compose init --help runs init rather than printing help, and rewrites .mcp.json with machine-specific absolute paths; compose new --auto skips only the six questionnaire questions and locks in research=yes, which is the single largest time cost.

## Open threads

COMP-WS-ISOLATION-1: auth store pinned to the startup project; device listing, pairing, revocation and secret rotation read and write the wrong project after a switch, and in remote mode a token paired under one project is accepted against another. COMP-WS-CLIENTSTATE-1: roughly fifteen client stores and several un-namespaced compose:* localStorage keys still go stale on switch; recommended fix is a project-generation counter plus a subscribable project-changed signal so new stores get this by default. COMP-UX-ONRAMP-1: every empty state leads with feature creation before any idea exists, and the ideabox zero-state points at the CLI.
