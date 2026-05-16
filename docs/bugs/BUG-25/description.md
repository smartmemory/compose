# BUG-25: Project tooltip in upper-left doesn't dismiss on click-away

## Source

GitHub issue: https://github.com/smartmemory/compose/issues/25

## Problem

Clicking the project name in the upper-left opens a tooltip/popover that does not dismiss when clicking elsewhere.

## Repro

1. Click the project name in the upper-left.
2. Tooltip/popover appears.
3. Click elsewhere.
4. Tooltip/popover stays visible.

## Expected

Standard popover dismissal:

- Click outside closes it.
- Escape closes it.

## Acceptance

- Tooltip/popover dismisses on outside click.
- Tooltip/popover dismisses on Escape key.
