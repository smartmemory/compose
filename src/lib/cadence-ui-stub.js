// Stand-in for `@cadence/ui` when the sibling package is absent (CI, published npm Compose).
// The Cadence tab is hidden in that build (`__CADENCE_UI__` is false), so none of this renders.
export const DataClientProvider = ({ children }) => children;
export const SeatStrip = () => null;
export const UnitBelt = () => null;
export const ChainDags = () => null;
export const ChainGraph = () => null;
export const AttentionList = () => null;
export const DiaryFeed = () => null;
export const LiveLanes = () => null;
// COMP-UI-LINKS-1: the Fleet room's parts. FleetView falls back to its own cards when the package is absent.
export const NavProvider = ({ children }) => children;
export const OwnerAsks = () => null;
export const ReadyUnits = () => null;
export const VitalsPanel = () => null;
export const LedgerTail = () => null;
export const JobsPanel = () => null;
export const SessionsPanel = () => null;
export const GatePanel = () => null;
