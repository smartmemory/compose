import { useEffect, useState } from 'react';

/** Page names served at /ops-status (COMPOSE-OPS-TAB-1). [] when the route is absent or empty. */
export default function useOpsStatusIndex() {
  const [pages, setPages] = useState([]);
  useEffect(() => {
    let live = true;
    fetch('/api/ops-status/index')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && Array.isArray(j?.pages)) setPages(j.pages); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return pages;
}
