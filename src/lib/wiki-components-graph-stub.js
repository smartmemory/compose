// Stand-in for `@wiki/components/graph` when the wiki checkout is absent (CI, published npm Compose).
// The Wiki tab is hidden in that build (`__WIKI_COMPONENTS__` is false), so none of this renders.
export const GraphPage = () => null;
export const GraphHost = ({ children }) => children;
export const GRAPH_ASPECTS = [];
export const resetWebGL2Probe = () => {};
export const wholeGraph = async () => ({ items: [], edges: [], total: 0, layout: null });
