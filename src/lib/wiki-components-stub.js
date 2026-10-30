// Stand-in for `@wiki/components` when the wiki checkout is absent (CI, published npm Compose).
// The Wiki tab is hidden in that build (`__WIKI_COMPONENTS__` is false), so none of this renders.
export const WikiDataProvider = ({ children }) => children;
export const FeatureHub = () => null;
export const Search = () => null;
export const Decisions = () => null;
export const Sources = () => null;
export const AreaDocs = () => null;
export const Ledger = () => null;
export const wikiPath = () => '/';
