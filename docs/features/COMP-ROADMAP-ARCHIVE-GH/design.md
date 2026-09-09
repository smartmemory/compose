# COMP-ROADMAP-ARCHIVE-GH: Two-document transactional publication for the GitHub tracker provider. COMP-ROADMAP-ARCHIVE v1 is local-provider only: GitHubProvider regenerates and publishes one roadmap document with a Contents API SHA check, and two independent Contents writes cannot claim atomicity. Publish the active/archive document set as one Git tree and one commit with a guarded ref update and conflict retry; an issue status transition may already be committed when publication fails, so report and repair that projection without repeating the transition. Provider parity for archival is complete only when this ships. Features M medium

**Status:** PLANNED
**Created:** 2026-09-09

---

## Intent

Two-document transactional publication for the GitHub tracker provider. COMP-ROADMAP-ARCHIVE v1 is local-provider only: GitHubProvider regenerates and publishes one roadmap document with a Contents API SHA check, and two independent Contents writes cannot claim atomicity. Publish the active/archive document set as one Git tree and one commit with a guarded ref update and conflict retry; an issue status transition may already be committed when publication fails, so report and repair that projection without repeating the transition. Provider parity for archival is complete only when this ships. Features M medium

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._
