/**
 * LinkedMarkdown — COMP-UI-LINKS-2: MarkdownViewer with its feature codes and repo paths opening through the navigation context
 * (the same calls EntityLink makes). Only tokens the context can open become links; the rest stay text. A click on one is caught
 * here, so the markdown renderer needs no knowledge of the cockpit.
 *
 * COMP-UI-LINKS-2-FU-1: tokens are linked on the parser's tree (a remark plugin over text nodes), not by regex over the source, so
 * reference links, link definitions, any-length code spans and tilde fences are never rewritten. An authored `#entity:` link goes
 * through the same canOpenEntity as a token: one the context cannot open renders as text with the reason, and no click reaches it.
 */
import React, { useMemo } from 'react';
import MarkdownViewer from './MarkdownViewer.jsx';
import { useNavigation } from '@/lib/navigation.jsx';
import { canOpenEntity, noTargetReason, openEntity } from '../../shared/EntityLink.jsx';
import { ENTITY_HREF, parseEntityHref, remarkLinkEntities } from '@/lib/entityParts.js';

export default function LinkedMarkdown({ content, className }) {
  const nav = useNavigation();
  const plugins = useMemo(
    () => (nav ? [remarkLinkEntities((kind, value) => canOpenEntity(nav, kind, value))] : []),
    [nav],
  );
  const components = useMemo(() => ({
    a: ({ href, children, node: _node, ...rest }) => {
      if (typeof href !== 'string' || !href.startsWith(ENTITY_HREF)) return <a href={href} {...rest}>{children}</a>;
      const target = parseEntityHref(href);
      if (target && nav && canOpenEntity(nav, target.kind, target.id)) return <a href={href} {...rest}>{children}</a>;
      return <span title={target ? noTargetReason(nav, target.kind, target.id) : 'Not a link the cockpit can open'} data-no-target="">{children}</span>;
    },
  }), [nav]);
  const onClick = (e) => {
    const a = e.target.closest?.('a');
    const target = parseEntityHref(a?.getAttribute('href'));
    if (!target || !nav) return;
    e.preventDefault();
    if (canOpenEntity(nav, target.kind, target.id)) openEntity(nav, target.kind, target.id);
  };
  return <div onClick={onClick}><MarkdownViewer content={content} className={className} remarkPlugins={plugins} components={components} /></div>;
}
