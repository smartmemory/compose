/**
 * LinkedMarkdown — COMP-UI-LINKS-2: MarkdownViewer with its feature codes and repo paths opening through the navigation context
 * (the same calls EntityLink makes). Only tokens the context can open become links; the rest stay text. A click on one is caught
 * here, so the markdown renderer needs no knowledge of the cockpit.
 */
import React, { useMemo } from 'react';
import MarkdownViewer from './MarkdownViewer.jsx';
import { useNavigation } from '@/lib/navigation.jsx';
import { canOpenEntity, openEntity } from '../../shared/EntityLink.jsx';
import { linkEntitiesInMarkdown, parseEntityHref } from '@/lib/entityParts.js';

export default function LinkedMarkdown({ content, className }) {
  const nav = useNavigation();
  const linked = useMemo(
    () => (nav ? linkEntitiesInMarkdown(content, (kind, value) => canOpenEntity(nav, kind, value)) : content),
    [nav, content],
  );
  const onClick = (e) => {
    const a = e.target.closest?.('a');
    const target = parseEntityHref(a?.getAttribute('href'));
    if (!target || !nav) return;
    e.preventDefault();
    openEntity(nav, target.kind, target.id);
  };
  return <div onClick={onClick}><MarkdownViewer content={linked} className={className} /></div>;
}
