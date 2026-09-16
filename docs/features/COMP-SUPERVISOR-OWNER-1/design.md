# COMP-SUPERVISOR-OWNER-1: compose start SIGTERMs whatever supervisor the machine-wide PID file names (server/supervisor.js:80-93 killExistingSupervisor) before binding :4001, so starting the app from any project replaces another project's running server. Took down the owner's server during COMP-HOST-PORTABILITY-1. Verify ownership (same target project) and require explicit takeover, or scope supervisor identity per project. Gap G8.

**Status:** PLANNED
**Created:** 2026-09-16

---

## Intent

compose start SIGTERMs whatever supervisor the machine-wide PID file names (server/supervisor.js:80-93 killExistingSupervisor) before binding :4001, so starting the app from any project replaces another project's running server. Took down the owner's server during COMP-HOST-PORTABILITY-1. Verify ownership (same target project) and require explicit takeover, or scope supervisor identity per project. Gap G8.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._
