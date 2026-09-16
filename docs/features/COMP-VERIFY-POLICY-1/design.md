# COMP-VERIFY-POLICY-1: Build triage silently downgrades a feature's requested verification: feature.json needs_verification true became false at runtime and Stratum recorded the step skipped with no warning (COMP-HOST-PORTABILITY-1 SD08, host B). Preserve explicit feature requirements, or require a visible recorded override before skipping verification. Gap G9.

**Status:** PLANNED
**Created:** 2026-09-16

---

## Intent

Build triage silently downgrades a feature's requested verification: feature.json needs_verification true became false at runtime and Stratum recorded the step skipped with no warning (COMP-HOST-PORTABILITY-1 SD08, host B). Preserve explicit feature requirements, or require a visible recorded override before skipping verification. Gap G9.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._
