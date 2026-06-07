import React, { useState, useEffect, useRef, useId } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import { cn } from '@/lib/utils.js';

/**
 * MarkdownViewer — shared markdown renderer (COMP-COCKPIT-4).
 *
 * Extracted from DocsView so both DocsView and GateView (inline gate-artifact
 * review) render markdown identically: ReactMarkdown + remarkGfm, with mermaid
 * code fences rendered as diagrams. Wraps output in the prose styling DocsView
 * used; pass `className` to override the wrapper classes.
 *
 * Props:
 *   content    — markdown string
 *   className? — override the default prose wrapper classes
 */

// Initialize mermaid once with dark theme (module-level, idempotent).
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#3b82f6',
    primaryTextColor: '#e2e8f0',
    lineColor: '#475569',
    secondaryColor: '#1e293b',
    tertiaryColor: '#0f172a',
  },
});

export function MermaidBlock({ code }) {
  const containerRef = useRef(null);
  const uniqueId = useId();
  const [svg, setSvg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${uniqueId.replace(/:/g, '')}`;
    mermaid.render(id, code)
      .then(({ svg: rendered }) => { if (!cancelled) setSvg(rendered); })
      .catch(err => { if (!cancelled) setError(err.message || 'Invalid diagram'); });
    return () => { cancelled = true; };
  }, [code, uniqueId]);

  if (error) {
    return (
      <pre className="text-[11px] text-destructive bg-destructive/10 border border-destructive/20 rounded p-3 overflow-x-auto">
        {`Mermaid error: ${error}\n\n${code}`}
      </pre>
    );
  }
  if (!svg) {
    return <div className="text-[11px] text-muted-foreground py-2">Rendering diagram...</div>;
  }
  return (
    <div
      ref={containerRef}
      className="my-3 overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function MarkdownCode({ className, children, ...props }) {
  const match = /language-(\w+)/.exec(className || '');
  const lang = match?.[1];
  if (lang === 'mermaid') {
    return <MermaidBlock code={String(children).trim()} />;
  }
  return <code className={className} {...props}>{children}</code>;
}

const DEFAULT_PROSE = `prose prose-sm prose-invert max-w-none
  prose-headings:text-foreground prose-p:text-muted-foreground
  prose-a:text-accent prose-strong:text-foreground
  prose-code:text-accent prose-code:bg-muted prose-code:px-1 prose-code:rounded
  prose-pre:bg-muted prose-pre:border prose-pre:border-border
  prose-li:text-muted-foreground prose-table:text-xs
  prose-th:text-foreground prose-td:text-muted-foreground
  prose-hr:border-border`;

export default function MarkdownViewer({ content, className }) {
  return (
    <article className={cn(DEFAULT_PROSE, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode }}>
        {content || ''}
      </ReactMarkdown>
    </article>
  );
}
