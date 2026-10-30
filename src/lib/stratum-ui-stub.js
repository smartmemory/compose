// Stand-in for `@smartmemory/stratum-ui` when neither the Mac sibling nor the installed package is present.
// The Stratum tab is hidden in that build (`__STRATUM_UI__` is false), so none of this renders.
export const DataClientProvider = ({ children }) => children;
export const RunsList = () => null;
export const RunDetail = () => null;
export const GatesInbox = () => null;
