# COMP-COCKPIT-11 — Wire ChallengeModal "Discuss" to a live route

**Status:** DESIGN · 2026-06-16

## Problem
`ChallengeModal.handleDiscuss` POSTs to `agentServerUrl('/api/terminal/inject')` — a route that
exists on **no** server. `server/terminal-server.js` was replaced by `server/agent-server.js`
(see its header), and the inject route was never carried over. The "Discuss" button 404s.

## Fix — repoint, don't remove
The agent server (:4002) already exposes the modern equivalent: `POST /api/agent/message`
(`server/agent-server.js:142`, body `{ prompt }`) — it resumes the session and sends the prompt to
the agent. Repoint `handleDiscuss`:
- URL `/api/terminal/inject` → `/api/agent/message`
- body `{ text }` → `{ prompt: text }`

`requireSensitiveToken` on that route is already satisfied by the existing `withComposeToken(...)`
headers. The error toast and `.xterm-helper-textarea` focus are unchanged.

## Out of scope
A bespoke terminal-inject endpoint — `/api/agent/message` is the correct existing surface, so no
server change is needed.

## Test
Extend `test/ui/challenge-modal-host.test.jsx`: clicking **Discuss** calls `wsFetch` with a URL
ending `/api/agent/message` (never `/api/terminal/inject`) and a `{ prompt }` body.
