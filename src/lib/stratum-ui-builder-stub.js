// Stand-in for `@smartmemory/stratum-ui/builder` when there is no sibling checkout and no installed package
// with `dist/builder.js` (COMP-SUBAPP-STRAT-AUTHOR-1). Without the package the Stratum tab is hidden
// (`__STRATUM_UI__` false); with a package built before the builder existed, the pane says so instead of going blank.
import { createElement } from 'react';

export const FlowBuilder = () => createElement('div', { className: 'p-4 text-sm text-muted-foreground', 'data-testid': 'flow-builder-stub' },
  'The flow builder is not in this @smartmemory/stratum-ui build.');
