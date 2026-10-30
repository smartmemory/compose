// Stand-in for `@cadence/ui` when the sibling package is absent (CI, published npm Compose).
// The Cadence tab is hidden in that build (`__CADENCE_UI__` is false), so none of this renders.
export const DataClientProvider = ({ children }) => children;
export const SeatStrip = () => null;
export const UnitBelt = () => null;
export const ChainDags = () => null;
export const AttentionList = () => null;
export const DiaryFeed = () => null;
