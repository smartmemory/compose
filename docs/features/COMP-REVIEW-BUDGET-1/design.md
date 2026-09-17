# COMP-REVIEW-BUDGET-1: Review lenses send unbounded prompts and treat a bounded provider rate limit as terminal: COMP-HOST-PORTABILITY-1 host B selected three Claude lenses (claude-sonnet-5); two failed with 'Prompt is too long', their automatic retries then failed with a visible provider rate-limit error, and because the fanout is require:all the whole review failed loudly and terminated the first lifecycle flow after $14.04 of completed work. The third diff-quality lens returned normally, so this is a prompt-size and retry-policy defect, not a lens defect. Every review using the require:all path is affected. Budget lens context against a real prompt ceiling, and handle a bounded provider retry with resumable state instead of assuming the rate limit is permanent. Loud, not silent. Sized M and BLOCKS the measured host B run. Gap G3.

**Status:** PLANNED
**Created:** 2026-09-17

---

## Intent

Review lenses send unbounded prompts and treat a bounded provider rate limit as terminal: COMP-HOST-PORTABILITY-1 host B selected three Claude lenses (claude-sonnet-5); two failed with 'Prompt is too long', their automatic retries then failed with a visible provider rate-limit error, and because the fanout is require:all the whole review failed loudly and terminated the first lifecycle flow after $14.04 of completed work. The third diff-quality lens returned normally, so this is a prompt-size and retry-policy defect, not a lens defect. Every review using the require:all path is affected. Budget lens context against a real prompt ceiling, and handle a bounded provider retry with resumable state instead of assuming the rate limit is permanent. Loud, not silent. Sized M and BLOCKS the measured host B run. Gap G3.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._
