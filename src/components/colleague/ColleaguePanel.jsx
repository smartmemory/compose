/**
 * ColleaguePanel — the summonable Maya slide-over (COMP-FOH FOH-6 S3).
 *
 * A right-docked overlay (scrim + panel) over whatever view the owner is
 * already on — Maya is ambient, not a main-area tab. The panel renders the
 * design's funnel state machine and NEVER a degraded plain-chat mode
 * (COLLEAGUE-ALL-IN): every degraded condition is an explanatory funnel with
 * the fix, never a hidden button (funnel-not-hide, seam doctrine).
 *
 * Views, derived from /api/maya/status plus per-turn errors:
 *   loading → connect-smartmemory → offline → workspace-collision → auth → chat
 *
 * Record-in-focus follows the cockpit (the Ideabox selection) with a manual
 * override picker; no focus → corpus-level context server-side. Write-back
 * outcomes render as chips per reply: ok / landed-unrendered (visible warning
 * + re-render repair — the projection stays stale until repaired) / failed
 * (retry is APPEND-ONLY — the chat turn is never re-sent).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  X, Sparkles, RefreshCw, AlertTriangle, KeyRound, Database, WifiOff, ShieldAlert, Check,
} from 'lucide-react';
import { wsFetch } from '../../lib/wsFetch.js';
import ChatInput from '../agent/ChatInput.jsx';
import MessageCard from '../agent/MessageCard.jsx';
import { useIdeaboxStore } from '../vision/useIdeaboxStore.js';

function parseSseFrame(frame) {
  let event = 'message';
  const data = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  try {
    return { event, body: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

function updateLastMaya(messages, update) {
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== 'maya') index -= 1;
  if (index < 0) return messages;
  const next = [...messages];
  next[index] = update(next[index]);
  return next;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function FunnelCard({ icon: Icon, title, children, actions }) {
  return (
    <div className="flex-1 flex items-center justify-center p-7">
      <div className="max-w-[340px] text-center flex flex-col gap-2.5 items-center">
        <Icon style={{ width: 28, height: 28, color: 'hsl(var(--muted-foreground))' }} />
        <h2 className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{title}</h2>
        <div className="text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {children}
        </div>
        {actions && <div className="flex gap-2 flex-wrap justify-center mt-1">{actions}</div>}
      </div>
    </div>
  );
}

function FunnelAction({ onClick, children, sub }) {
  return (
    <button
      onClick={onClick}
      className="rounded px-3 py-1.5 text-xs text-left"
      style={{
        background: 'hsl(var(--accent) / 0.12)',
        color: 'hsl(var(--accent))',
        border: '1px solid hsl(var(--accent) / 0.3)',
      }}
    >
      {children}
      {sub && (
        <small className="block font-normal text-[9px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
          {sub}
        </small>
      )}
    </button>
  );
}

function CapabilityStrip({ capabilities }) {
  if (!capabilities) return null;
  const chip = (label, on) => (
    <span
      key={label}
      className="text-[9px] uppercase tracking-wider rounded px-1.5 py-0.5"
      style={on
        ? { background: 'hsl(var(--accent) / 0.12)', color: 'hsl(var(--accent))' }
        : { background: 'hsl(var(--muted) / 0.5)', color: 'hsl(var(--muted-foreground))', textDecoration: 'line-through' }}
      title={on ? `${label} active` : `${label} unavailable (blocked upstream — not faked)`}
    >
      {label}{!on && ' unavailable'}
    </span>
  );
  return (
    <div className="flex gap-1 flex-wrap px-3 py-1.5" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
      {chip('challenge', capabilities.challenge)}
      {chip('conviction', capabilities.conviction)}
      {chip('contradiction', capabilities.contradiction)}
      {chip('calibration', capabilities.calibration)}
    </div>
  );
}

/** The findings accordion (design §4): the latest turn's composed findings
 *  blocks — conviction, contradictions, challenge — collapsible under the
 *  header, with provenance authors. Record/discussion blocks are context, not
 *  findings, and stay out of it. */
export function FindingsAccordion({ blocks }) {
  const findings = (blocks ?? []).filter((b) =>
    ['compose:conviction', 'compose:contradiction', 'compose:challenge', 'compose:portfolio']
      .includes(b.author));
  if (!findings.length) return null;

  // Grouped by source, because a portfolio turn returns findings from several
  // products and their relevance scores are NOT comparable across products
  // (`RecallHit.score` is the provider's own, passed through untouched). A single
  // ranked list would imply a calibration that does not exist. A project-scoped
  // turn has no source on its blocks and falls into one unlabelled group, which
  // renders exactly as it does today.
  const groups = [];
  const byKey = new Map();
  for (const b of findings) {
    const key = b.source ? `${b.source.id}\u0000${b.source.root}` : '';
    if (!byKey.has(key)) {
      const group = { key, source: b.source ?? null, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).items.push(b);
  }

  return (
    <details
      className="px-3 py-1.5 text-[11px]"
      style={{ borderBottom: '1px solid hsl(var(--border))' }}
      data-testid="findings-accordion"
    >
      <summary className="cursor-pointer select-none" style={{ color: 'hsl(var(--muted-foreground))' }}>
        findings ({findings.length})
      </summary>
      <div className="flex flex-col gap-1.5 mt-1.5">
        {groups.map((group) => (
          <div key={group.key || 'this-project'} data-testid="findings-group">
            {group.source && (
              <div
                className="text-[9px] uppercase tracking-wider"
                style={{ color: 'hsl(var(--muted-foreground))' }}
                data-testid="findings-source"
                title={group.source.root}
              >
                {group.source.id}
              </div>
            )}
            {group.items.map((b, i) => (
              // Keyed on source + author + position, never `b.author` alone:
              // N products all emit `compose:conviction`, and a bare author key
              // collides across them.
              <div key={`${group.key}\u0000${b.author}\u0000${i}`}>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: 'hsl(var(--accent))' }}>
                  {b.author.replace(/^compose:/, '')}
                </div>
                <div className="whitespace-pre-wrap" style={{ color: 'hsl(var(--foreground))' }}>{b.text}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

/** Per-reply context note: what was sent, and every named omission — a
 *  truncated turn must never look like a clean one. */
export function ContextNote({ context }) {
  if (!context) return null;
  // Deduped: N sources emitting the same author would otherwise render
  // "conviction · conviction · conviction".
  const sent = [...new Set((context.sent ?? []).map((a) => a.replace(/^compose:/, '')))].join(' · ');
  return (
    <div className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
      {sent && <span>context sent: {sent}</span>}
      {(context.omissions ?? []).map((o, i) => (
        <span key={`${i}\u0000${o}`} className="ml-1.5" style={{ color: 'hsl(var(--destructive) / 0.9)' }}>— {o}</span>
      ))}
    </div>
  );
}

function WritebackChip({ writeback, messageId, replyText, onRetry, onRepair }) {
  if (!writeback || !writeback.outcome) return null;
  const { outcome, focusId } = writeback;
  if (outcome === 'ok') {
    return (
      <div className="flex items-center gap-1 text-[10px] mt-0.5" style={{ color: 'hsl(var(--accent))' }}>
        <Check style={{ width: 10, height: 10 }} /> noted on {focusId}
      </div>
    );
  }
  if (outcome === 'landed-unrendered') {
    return (
      <div className="flex items-center gap-1.5 text-[10px] mt-0.5" style={{ color: 'hsl(38 92% 50%)' }}>
        <AlertTriangle style={{ width: 10, height: 10 }} />
        saved to {focusId}, but the ideabox file is stale
        <button
          className="underline"
          onClick={() => onRepair(focusId)}
          style={{ color: 'inherit', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          re-render
        </button>
      </div>
    );
  }
  if (outcome === 'failed') {
    return (
      <div className="flex items-center gap-1.5 text-[10px] mt-0.5" style={{ color: 'hsl(var(--destructive))' }}>
        <AlertTriangle style={{ width: 10, height: 10 }} />
        not saved to {focusId}
        <button
          className="underline"
          onClick={() => onRetry({ focusId, messageId, replyText })}
          style={{ color: 'inherit', background: 'none', border: 'none', cursor: 'pointer' }}
          title="Retry the discussion append only — the chat turn is never re-sent"
        >
          retry
        </button>
      </div>
    );
  }
  if (outcome === 'unknown') {
    // The stream ended after `final` but before the relay's writeback event —
    // the append may or may not have landed. Never let that read as clean
    // (§5 outcome contract); retry is reconcile-then-append, so it dedups
    // into a no-op if the original landed.
    return (
      <div className="flex items-center gap-1.5 text-[10px] mt-0.5" style={{ color: 'hsl(38 92% 50%)' }}>
        <AlertTriangle style={{ width: 10, height: 10 }} />
        save to {focusId} unconfirmed — connection dropped
        <button
          className="underline"
          onClick={() => onRetry({ focusId, messageId, replyText })}
          style={{ color: 'inherit', background: 'none', border: 'none', cursor: 'pointer' }}
          title="Reconcile-then-append — a no-op if the original save landed"
        >
          retry
        </button>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function ColleaguePanel({ onClose, status, refreshStatus }) {
  const ideas = useIdeaboxStore((s) => s.ideas);
  const selectedIdeaId = useIdeaboxStore((s) => s.selectedIdeaId);
  const hydrate = useIdeaboxStore((s) => s.hydrate);

  // undefined = follow the cockpit; null = whole ideabox; string = pinned handle
  const [focusOverride, setFocusOverride] = useState(undefined);
  // 'project' (or undefined) asks this product; 'portfolio' asks every declared
  // member. A portfolio turn spans products, so it CANNOT be focused on one
  // idea and cannot write back — the backend refuses both, and the panel must
  // not offer what the backend will refuse.
  const [scope, setScope] = useState('project');
  const isPortfolio = scope === 'portfolio';
  const focusId = isPortfolio
    ? null
    : (focusOverride === undefined ? (selectedIdeaId ?? null) : focusOverride);

  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(false);
  const [streamReplyStarted, setStreamReplyStarted] = useState(false);
  const [writebackOn, setWritebackOn] = useState(true); // design §5: toggleable, default on
  const [authError, setAuthError] = useState(null);
  // Copy for the misconfigured funnel when a TURN routes into it; null means the
  // startup-probe default (a missing maya baseUrl).
  // A turn that failed with a kind that HAS a funnel view ('misconfigured',
  // 'workspace-collision'). Cleared at the start of the next turn, like
  // `offlineError` — a funnel that outlives the condition that opened it is a
  // dead end the user cannot leave.
  const [turnFunnel, setTurnFunnel] = useState(null);
  const [offlineError, setOfflineError] = useState(null);
  const [pasting, setPasting] = useState(false);
  const pasteRef = useRef(null);
  const scrollRef = useRef(null);

  // Fresh status on open; hydrate the ideas list for the focus picker.
  useEffect(() => {
    refreshStatus?.();
    if (typeof hydrate === 'function') Promise.resolve(hydrate()).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastMessageTextLength = messages[messages.length - 1]?.text?.length ?? 0;
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
  }, [messages.length, lastMessageTextLength]);

  async function postJson(url, body) {
    const r = await wsFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  function handleTurnError(error) {
    // `misconfigured` and `workspace-collision` already HAVE funnel views; they
    // were reachable only from the startup status probe, so a turn that failed
    // for either reason showed one grey line of chat text instead. Connecting
    // them is the wiring S4 asks for — with the copy carried from the error, so
    // the card explains the actual problem.
    if (error?.kind === 'misconfigured' || error?.kind === 'workspace-collision') {
      // `view` is DERIVED, not state (see the view derivation below), so a turn
      // funnel is opened the way `auth` and `offline` are: by setting the error
      // the derivation reads.
      setTurnFunnel({
        kind: error.kind,
        title: error.kind === 'workspace-collision'
          ? "This portfolio overlaps the colleague's own memory"
          : 'This turn is misconfigured',
        body: error.message,
      });
      return;
    }
    if (error?.kind === 'auth') {
      setAuthError(error);
    } else if (error?.kind === 'offline') {
      setOfflineError(error);
      refreshStatus?.();
    } else {
      setMessages((m) => [...m, {
        role: 'error',
        text: `${error?.kind ?? 'error'}: ${error?.message ?? 'the turn failed'}`,
      }]);
    }
  }

  async function send(text) {
    setPending(true);
    setStreamReplyStarted(false);
    setOfflineError(null);
    setTurnFunnel(null);
    setMessages((m) => [...m, { role: 'user', text }]);
    let hasStreamMessage = false;
    let sawFinal = false;
    let sawError = false;
    // Captured at send time: whether this turn owes a terminal writeback
    // event. If the stream dies between `final` and that event, the outcome
    // is UNKNOWN, never silently clean (§5 outcome contract, Codex r1 P2).
    const expectWriteback = Boolean(focusId) && writebackOn && !isPortfolio;
    const turnFocusId = focusId;
    let sawWriteback = false;

    const markInterrupted = () => {
      setMessages((m) => updateLastMaya(m, (msg) => ({
        ...msg, streaming: false, failed: true,
      })));
    };

    try {
      const res = await wsFetch('/api/maya/message?stream=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, focusId, scope, writeback: writebackOn && !isPortfolio }),
      });
      const contentType = (res.headers?.get?.('Content-Type') ?? '')
        .split(';', 1)[0].trim().toLowerCase();

      if (contentType === 'application/json') {
        const body = await res.json();
        if (body.ok) {
          setMessages((m) => [...m, {
            role: 'maya', text: body.reply, messageId: body.message_id,
            writeback: body.writeback, context: body.context,
          }]);
        } else {
          handleTurnError(body.error);
        }
        return;
      }

      if (contentType !== 'text/event-stream') {
        throw new Error(`unexpected response content type: ${contentType || 'missing'}`);
      }
      const reader = res.body?.getReader?.();
      if (!reader) throw new Error('stream response has no readable body');

      const decoder = new TextDecoder();
      let buffer = '';
      const handleFrame = (frame) => {
        const parsed = parseSseFrame(frame);
        if (!parsed) return;
        const { event, body } = parsed;

        if (event === 'token') {
          if (!hasStreamMessage) {
            hasStreamMessage = true;
            setStreamReplyStarted(true);
            setMessages((m) => [...m, { role: 'maya', streaming: true, text: '' }]);
          }
          const chunk = String(body?.text ?? '');
          setMessages((m) => updateLastMaya(m, (msg) => ({
            ...msg, text: `${msg.text}${chunk}`,
          })));
          return;
        }

        if (event === 'final') {
          sawFinal = true;
          setStreamReplyStarted(true);
          if (!hasStreamMessage) {
            hasStreamMessage = true;
            setMessages((m) => [...m, {
              role: 'maya', text: body.reply, messageId: body.message_id,
              context: body.context, streaming: false,
            }]);
          } else {
            setMessages((m) => updateLastMaya(m, (msg) => ({
              ...msg,
              text: body.reply,
              messageId: body.message_id,
              context: body.context,
              streaming: false,
              failed: false,
            })));
          }
          return;
        }

        if (event === 'writeback') {
          sawWriteback = true;
          if (hasStreamMessage && sawFinal) {
            setMessages((m) => updateLastMaya(m, (msg) => ({ ...msg, writeback: body })));
          }
          return;
        }

        if (event === 'error') {
          sawError = true;
          if (hasStreamMessage && !sawFinal) markInterrupted();
          handleTurnError(body);
        }
      };

      const drainFrames = () => {
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1 && !sawError) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleFrame(frame);
          boundary = buffer.indexOf('\n\n');
        }
      };

      while (!sawError) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          drainFrames();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        drainFrames();
      }

      if (!sawFinal && !sawError) {
        if (hasStreamMessage) {
          markInterrupted();
        } else {
          setMessages((m) => [...m, {
            role: 'error', text: 'request failed: stream ended before a final reply',
          }]);
        }
      }
    } catch (e) {
      if (!sawFinal && hasStreamMessage) {
        markInterrupted();
      } else if (!sawFinal && !sawError) {
        setMessages((m) => [...m, { role: 'error', text: `request failed: ${e.message}` }]);
      }
    } finally {
      // Covers both the clean-close and the thrown-mid-drain paths: a turn
      // that owed a writeback event but never got one ends UNKNOWN, with the
      // idempotent retry affordance — never silently clean.
      if (sawFinal && expectWriteback && !sawWriteback) {
        setMessages((m) => updateLastMaya(m, (msg) => ({
          ...msg, writeback: { outcome: 'unknown', focusId: turnFocusId },
        })));
      }
      setPending(false);
      setStreamReplyStarted(false);
    }
  }

  async function retryWriteback({ focusId: fid, messageId, replyText }) {
    const body = await postJson('/api/maya/writeback-retry', {
      focusId: fid, message_id: messageId, text: replyText,
    });
    const outcome = body.ok ? (body.writeback?.outcome ?? 'ok') : 'failed';
    setMessages((m) => m.map((msg) => (
      msg.messageId === messageId
        ? { ...msg, writeback: { ...(msg.writeback ?? {}), outcome, focusId: fid } }
        : msg
    )));
  }

  async function repairRender() {
    // Re-render the ideabox projection (the durable record already landed).
    await postJson('/api/ideabox/render', {}).catch(() => {});
  }

  async function reprovision() {
    const body = await postJson('/api/maya/identity', { action: 'reprovision' });
    if (body.ok) {
      setAuthError(null);
      setMessages([]);
      refreshStatus?.();
    }
  }

  async function pasteToken() {
    const token = pasteRef.current?.value?.trim();
    if (!token) return;
    const body = await postJson('/api/maya/identity', { action: 'static', token });
    if (body.ok) {
      setAuthError(null);
      setPasting(false);
      refreshStatus?.();
    } else {
      // EVERY refusal renders — the paste flow fails closed server-side
      // (unverifiable tokens are not stored), and a Save that silently does
      // nothing would hide the actionable explanation (Codex r2 P2).
      setAuthError({
        kind: 'auth',
        message: body.error?.message ?? `token refused (${body.error?.kind ?? 'unknown error'})`,
      });
    }
  }

  // ── view derivation ──────────────────────────────────────────────────────
  let view;
  if (turnFunnel) view = turnFunnel.kind;
  else if (authError) view = 'auth';
  else if (offlineError) view = 'offline';
  else if (!status) view = 'loading';
  else if (status.state === 'misconfigured') view = 'misconfigured';
  else if (status.state === 'connect-smartmemory') view = 'connect-smartmemory';
  else if (status.state === 'offline') view = 'offline';
  else if (status.state === 'workspace-collision') view = 'workspace-collision';
  else if (status.state === 'auth') view = 'auth'; // e.g. static mode, no token pasted yet
  else if (status.state === 'ready') view = 'chat';
  else view = 'loading';

  const focusLabel = focusId ?? 'whole ideabox';

  return (
    <div className="fixed inset-0 z-50" data-testid="colleague-panel">
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.35)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="absolute right-0 top-0 h-full w-[440px] max-w-[92vw] flex flex-col shadow-2xl"
        style={{ background: 'hsl(var(--background))', borderLeft: '1px solid hsl(var(--border))' }}
        role="dialog"
        aria-label="Maya — colleague"
      >
        {/* header */}
        <div
          className="flex items-center gap-2 px-3 h-10 shrink-0"
          style={{ borderBottom: '1px solid hsl(var(--border))' }}
        >
          <Sparkles style={{ width: 14, height: 14, color: 'hsl(var(--accent))' }} />
          <span className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Maya</span>
          {view === 'chat' && (
            <select
              className="text-[10px] bg-transparent rounded px-1 py-0.5 max-w-[180px]"
              style={{ color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))' }}
              value={focusOverride === undefined ? '__follow__' : (focusOverride ?? '__corpus__')}
              onChange={(e) => {
                const v = e.target.value;
                setFocusOverride(v === '__follow__' ? undefined : (v === '__corpus__' ? null : v));
              }}
              title={`Discussing: ${focusLabel}`}
              aria-label="Record in focus"
            >
              <option value="__follow__">
                follow cockpit{selectedIdeaId ? ` (${selectedIdeaId})` : ''}
              </option>
              <option value="__corpus__">whole ideabox</option>
              {ideas.map((i) => (
                <option key={i.id} value={i.id}>{i.id}</option>
              ))}
            </select>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="compose-btn-icon"
            aria-label="Close colleague panel"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {view === 'chat' && <CapabilityStrip capabilities={status.capabilities} />}
        {view === 'chat' && (
          <FindingsAccordion
            blocks={[...messages].reverse().find((m) => m.role === 'maya')?.context?.blocks}
          />
        )}

        {/* body */}
        {view === 'loading' && (
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
            checking Maya…
          </div>
        )}

        {view === 'misconfigured' && (
          <FunnelCard icon={AlertTriangle} title={turnFunnel?.title ?? 'Maya is misconfigured'}>
            {/* Parameterized: this card used to state unconditionally that the
                `maya` block lacks a `baseUrl`. A portfolio misconfiguration
                routed into it would have sent the reader to fix a setting that
                is not the problem — worse than the inline error it replaces. */}
            {turnFunnel?.body ?? (
              <>
                The <code>maya</code> block in <code>.compose/compose.json</code> is present but has
                no <code>baseUrl</code>. Point it at the Maya deployment
                (local dev: <code>http://localhost:9005</code>).
              </>
            )}
            {!turnFunnel && status?.error && (
              <div className="mt-1 font-mono text-[10px]">{status.error}</div>
            )}
                      {turnFunnel && (
              <FunnelAction onClick={() => setTurnFunnel(null)}>Back to the conversation</FunnelAction>
            )}
          </FunnelCard>
        )}

        {view === 'connect-smartmemory' && (
          <FunnelCard icon={Database} title="The colleague needs SmartMemory">
            Maya reasons over this project&apos;s fluid records through the SmartMemory
            service stack, and never runs degraded. Configure the SmartMemory fluid
            provider (<code>fluid.provider: &quot;smartmemory&quot;</code> in
            <code> .compose/compose.json</code>) to enable her.
          </FunnelCard>
        )}

        {view === 'offline' && (
          <FunnelCard
            icon={WifiOff}
            title="Maya is offline"
            actions={
              <FunnelAction onClick={() => { setOfflineError(null); refreshStatus?.(); }}>
                <span className="flex items-center gap-1"><RefreshCw style={{ width: 10, height: 10 }} /> retry</span>
              </FunnelAction>
            }
          >
            {status?.hint ?? 'start the Maya stack (dev.sh — port 9005), then reopen the panel'}
            {offlineError?.message && <div className="mt-1 font-mono text-[10px]">{offlineError.message}</div>}
          </FunnelCard>
        )}

        {view === 'workspace-collision' && (
          <FunnelCard icon={ShieldAlert} title={turnFunnel?.title ?? 'Refusing this token: workspace collision'}>
            {/* Parameterized for the same reason as the misconfigured card: a
                PORTFOLIO collision is a different overlap from a token whose own
                claim is the fluid workspace, and the startup copy would describe
                the wrong one. */}
            {turnFunnel?.body ?? (
              <>
                The colleague token&apos;s workspace claim IS the fluid workspace. Accepting
                it would let Maya&apos;s background ingestion write into the fluid records
                (deep binding — deferred, and never enabled by accident). Provision a
                dedicated colleague identity or paste a token scoped elsewhere.
              </>
            )}
            {!turnFunnel && status?.error && (
              <div className="mt-1 font-mono text-[10px]">{status.error}</div>
            )}
            {/* A funnel opened by a TURN must be leaveable. The status-probe
                funnels describe a condition that is still true, so they
                correctly have no exit; a failed turn does not — the panel was
                otherwise usable, and replacing it with a screen that has no way
                out is worse than the inline error this replaced. */}
            {turnFunnel && (
              <FunnelAction onClick={() => setTurnFunnel(null)}>Back to the conversation</FunnelAction>
            )}
          </FunnelCard>
        )}

        {view === 'auth' && (
          <FunnelCard
            icon={KeyRound}
            title="Maya rejected the colleague credential"
            actions={
              <>
                {status?.auth?.mode !== 'static' && (
                  <FunnelAction
                    onClick={reprovision}
                    sub="starts a fresh conversation — her accumulated colleague memory is lost"
                  >
                    re-provision
                  </FunnelAction>
                )}
                {!pasting && (
                  <FunnelAction onClick={() => setPasting(true)} sub="keeps whatever identity the token carries">
                    paste a new token
                  </FunnelAction>
                )}
              </>
            }
          >
            {authError
              ? 'The token was refused after one retry. A 401 does not prove expiry, and '
                + 're-provisioning destroys the standing thread — both recoveries are explicit, '
                + 'never automatic.'
              : 'No usable credential is stored for Maya yet.'}
            {(authError?.message ?? status?.error) && (
              <div className="mt-1 font-mono text-[10px]">{authError?.message ?? status?.error}</div>
            )}
            {pasting && (
              <div className="flex gap-1.5 mt-2">
                <input
                  ref={pasteRef}
                  type="password"
                  placeholder="paste token"
                  className="flex-1 text-[11px] font-mono rounded px-2 py-1 bg-transparent"
                  style={{ border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  aria-label="New Maya token"
                />
                <FunnelAction onClick={pasteToken}>save</FunnelAction>
              </div>
            )}
          </FunnelCard>
        )}

        {view === 'chat' && (
          <>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1">
              {messages.length === 0 && (
                <div className="text-[11px] mt-4 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Discussing: {focusLabel}. Maya sees the record, its conviction,
                  contradictions and challenge findings each turn.
                </div>
              )}
              {messages.map((msg, i) => {
                if (msg.role === 'user') {
                  return <MessageCard key={i} msg={{ type: 'user', message: { content: msg.text } }} />;
                }
                if (msg.role === 'error') {
                  return <MessageCard key={i} msg={{ type: 'error', message: msg.text }} />;
                }
                return (
                  <div key={i}>
                    <MessageCard msg={{ type: 'assistant', message: { content: [{ type: 'text', text: msg.text }] } }} />
                    {msg.failed && (
                      <div
                        className="text-[10px] mt-0.5"
                        style={{ color: 'hsl(var(--destructive))' }}
                      >
                        reply interrupted — not saved
                      </div>
                    )}
                    <ContextNote context={msg.context} />
                    <WritebackChip
                      writeback={msg.writeback}
                      messageId={msg.messageId}
                      replyText={msg.text}
                      onRetry={retryWriteback}
                      onRepair={repairRender}
                    />
                  </div>
                );
              })}
              {pending && !streamReplyStarted && (
                <div className="text-[11px] animate-pulse" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Maya is thinking…
                </div>
              )}
            </div>
            <label
              className="flex items-center gap-1.5 px-3 py-1 text-[10px] select-none"
              style={{
                color: 'hsl(var(--muted-foreground))',
                borderTop: '1px solid hsl(var(--border))',
                opacity: isPortfolio ? 0.5 : 1,
              }}
              title={isPortfolio
                ? 'A portfolio turn spans products and is read-only, so there is no single idea to note a reply on'
                : 'Append her replies about the focused idea to its discussion trail (author: maya)'}
            >
              <input
                type="checkbox"
                data-testid="writeback-toggle"
                checked={writebackOn && !isPortfolio}
                // Disabled, not merely inert. The backend already refuses a
                // portfolio writeback; leaving the control live would let the
                // panel promise something the server will decline, and the
                // "save unconfirmed" warning would then fire on a turn that was
                // never going to save anything.
                disabled={isPortfolio}
                onChange={(e) => setWritebackOn(e.target.checked)}
                style={{ accentColor: 'hsl(var(--accent))' }}
              />
              note replies on the idea
            </label>
            <label
              className="flex items-center gap-1.5 px-3 py-1 text-[10px] select-none"
              style={{ color: 'hsl(var(--muted-foreground))' }}
              title="Ask this product, or every product declared in fluid.portfolio"
            >
              scope
              <select
                data-testid="scope-select"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="bg-transparent"
                style={{ color: 'hsl(var(--foreground))' }}
              >
                <option value="project">this product</option>
                <option value="portfolio">every product</option>
              </select>
            </label>
            <ChatInput onSend={send} disabled={pending} placeholder="Message Maya…" />
          </>
        )}
      </div>
    </div>
  );
}
