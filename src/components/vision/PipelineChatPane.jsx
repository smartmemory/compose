/**
 * PipelineChatPane — COMP-PIPE-EDIT-CHAT-PANE-1.
 *
 * The Flow editor's default right pane: a per-spec chat that answers in text and may
 * attach ONE full-spec proposal. A proposal renders as a diff against the editor's current
 * YAML with Apply / Revert. Apply is in memory only (store.applyChatProposal); nothing
 * reaches disk until the user presses the normal Save. Zero props, all state in
 * useVisionStore so a pane switch never loses messages or an in-flight turn.
 *
 * Also exports PaneTabStrip, the [Chat] [Step] [Contracts] [YAML] switcher PipelineEditor
 * puts above whichever pane is showing.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils.js';
import { useVisionStore } from './useVisionStore.js';
import ChatInput from '../agent/ChatInput.jsx';
import ArtifactDiff from '../shared/ArtifactDiff.jsx';
import { serializeSpec, hashText, applyBlockReason, revertBlockReason } from './pipeline-pane-state.js';

const TABS = [
  { key: 'chat', shown: 'chat', label: 'Chat' },
  { key: 'auto', shown: 'inspector', label: 'Step' },
  { key: 'contracts', shown: 'contracts', label: 'Contracts' },
  { key: 'yaml', shown: 'yaml', label: 'YAML' },
];

/** `pane` is the stored value, `shown` what resolvePane returned. Step needs a selected step. */
export function PaneTabStrip({ pane, shown, hasSelection, hasModel, onPane }) {
  return (
    <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-border" role="tablist" data-testid="pane-tabs">
      {TABS.map((t) => {
        const disabled = (t.key === 'auto' && !hasSelection) || !hasModel;
        const active = shown === t.shown;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onPane(t.key)}
            data-testid={`pane-tab-${t.shown}`}
            className={cn(
              'text-[11px] px-2 py-0.5 rounded transition-colors',
              disabled ? 'opacity-40 cursor-not-allowed text-muted-foreground'
                : active ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground hover:bg-accent/10',
            )}
          >
            {t.label}
          </button>
        );
      })}
      {/* keeps `pane` visible to tests and to anyone reading the DOM */}
      <span className="sr-only" data-testid="pane-value">{pane}</span>
    </div>
  );
}

function Proposal({ index, msg, currentYaml, currentHash, readOnly, bufferPending, canRevert, revertReason }) {
  const applyChatProposal = useVisionStore((s) => s.applyChatProposal);
  const revertChatProposal = useVisionStore((s) => s.revertChatProposal);
  const [note, setNote] = useState('');
  const p = msg.proposal;
  const reason = msg.applied ? null : applyBlockReason({ proposal: p, currentHash, readOnly, bufferPending });

  const apply = async () => { const r = await applyChatProposal(index); setNote(r?.error || ''); };
  const revert = () => { const r = revertChatProposal(); setNote(r?.error || ''); };

  return (
    <div className="mt-2 rounded border border-border bg-muted/40 p-2" data-testid={`chat-proposal-${index}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Proposed edit</div>
      {!msg.applied && p.valid && <ArtifactDiff oldText={currentYaml} newText={p.yaml} />}
      {!p.valid && <p className="text-[11px] text-destructive" data-testid={`chat-proposal-error-${index}`}>{p.error}</p>}
      <div className="flex items-center gap-2 mt-1.5">
        {msg.applied ? (
          <>
            <span className="text-[11px] text-accent" data-testid={`chat-applied-${index}`}>Applied (unsaved)</span>
            {canRevert && !revertReason && (
              <button type="button" onClick={revert} data-testid={`chat-revert-${index}`}
                className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent/10">Revert</button>
            )}
          </>
        ) : (
          <button type="button" onClick={apply} disabled={!!reason} title={reason || 'Apply in the editor (not saved)'}
            data-testid={`chat-apply-${index}`}
            className={cn('text-[11px] px-2 py-0.5 rounded border',
              reason ? 'opacity-50 cursor-not-allowed text-muted-foreground border-border' : 'border-accent/60 text-accent hover:bg-accent/10')}>
            Apply
          </button>
        )}
        {reason && <span className="text-[10px] text-muted-foreground" data-testid={`chat-apply-reason-${index}`}>{reason}</span>}
        {msg.applied && canRevert && revertReason && <span className="text-[10px] text-muted-foreground" data-testid={`chat-revert-reason-${index}`}>{revertReason}</span>}
        {note && <span className="text-[10px] text-destructive">{note}</span>}
      </div>
    </div>
  );
}

export default function PipelineChatPane() {
  const file = useVisionStore((s) => s.editorSpecFile);
  const model = useVisionStore((s) => s.editorModel);
  const readOnly = useVisionStore((s) => s.editorReadOnly);
  const yamlBuffer = useVisionStore((s) => s.editorYamlBuffer);
  const yamlError = useVisionStore((s) => s.editorYamlError);
  const chat = useVisionStore((s) => (s.editorSpecFile ? s.chatByFile[s.editorSpecFile] : null));
  const chatUndo = useVisionStore((s) => s.chatUndo);
  const loadChat = useVisionStore((s) => s.loadChat);
  const sendChat = useVisionStore((s) => s.sendChat);
  const cancelChat = useVisionStore((s) => s.cancelChat);
  const clearChat = useVisionStore((s) => s.clearChat);

  const messages = chat?.messages || [];
  const busy = !!chat?.busy;
  const currentYaml = useMemo(() => serializeSpec(model), [model]);
  const [currentHash, setCurrentHash] = useState(null);
  const listRef = useRef(null);

  useEffect(() => { if (file) loadChat(file); }, [file, loadChat]);
  useEffect(() => {
    let live = true;
    hashText(currentYaml).then((h) => { if (live) setCurrentHash(h); });
    return () => { live = false; };
  }, [currentYaml]);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);

  if (!model) {
    return <div className="h-full p-4 text-xs text-muted-foreground" data-testid="chat-pane">Pick a spec to chat about it.</div>;
  }

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="chat-pane">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border">
        <span className="text-[11px] text-muted-foreground flex-1 truncate">Ask about {file}. Edits come back as a proposal you apply.</span>
        {busy && <button type="button" onClick={cancelChat} data-testid="chat-cancel" className="text-[11px] px-1.5 rounded border border-border hover:bg-accent/10">Stop</button>}
        <button type="button" onClick={clearChat} disabled={busy || messages.length === 0} data-testid="chat-clear"
          className="text-[11px] px-1.5 rounded border border-border hover:bg-accent/10 disabled:opacity-40">Clear</button>
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground" data-testid="chat-empty">
            Ask what a step does, why validation fails, or for a change. Select a step on the canvas to inspect it.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} data-testid={`chat-message-${i}`} data-role={m.role}
            className={cn('text-xs leading-relaxed whitespace-pre-wrap', m.role === 'user' ? 'text-foreground font-medium' : 'text-muted-foreground')}>
            {m.text || (m.streaming ? '…' : '')}
            {m.proposal && (
              <Proposal index={i} msg={m} currentYaml={currentYaml} currentHash={currentHash} readOnly={readOnly}
                bufferPending={yamlBuffer != null || !!yamlError}
                canRevert={!!chatUndo && chatUndo.file === file && chatUndo.index === i}
                revertReason={chatUndo && chatUndo.file === file && chatUndo.index === i ? revertBlockReason({ undo: chatUndo, currentYaml, bufferPending: yamlBuffer != null || !!yamlError }) : null} />
            )}
          </div>
        ))}
        {chat?.error && <p className="text-xs text-destructive" data-testid="chat-error">{chat.error}</p>}
      </div>

      <div className="shrink-0 sticky bottom-0 bg-background">
        <ChatInput onSend={sendChat} disabled={busy} placeholder="Ask about this spec…" />
      </div>
    </div>
  );
}
