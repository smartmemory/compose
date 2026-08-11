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

/** Per-reply context note: what was sent, and every named omission — a
 *  truncated turn must never look like a clean one. */
function ContextNote({ context }) {
  if (!context) return null;
  const sent = (context.sent ?? []).map((a) => a.replace(/^compose:/, '')).join(' · ');
  return (
    <div className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
      {sent && <span>context sent: {sent}</span>}
      {(context.omissions ?? []).map((o) => (
        <span key={o} className="ml-1.5" style={{ color: 'hsl(var(--destructive) / 0.9)' }}>— {o}</span>
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
  const focusId = focusOverride === undefined ? (selectedIdeaId ?? null) : focusOverride;

  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(false);
  const [authError, setAuthError] = useState(null);   // per-turn 'auth' error → auth funnel
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

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  async function postJson(url, body) {
    const r = await wsFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  async function send(text) {
    setPending(true);
    setOfflineError(null);
    setMessages((m) => [...m, { role: 'user', text }]);
    try {
      const body = await postJson('/api/maya/message', { text, focusId });
      if (body.ok) {
        setMessages((m) => [...m, {
          role: 'maya', text: body.reply, messageId: body.message_id,
          writeback: body.writeback, context: body.context,
        }]);
      } else if (body.error?.kind === 'auth') {
        setAuthError(body.error);
      } else if (body.error?.kind === 'offline') {
        setOfflineError(body.error);
        refreshStatus?.();
      } else {
        setMessages((m) => [...m, {
          role: 'error',
          text: `${body.error?.kind ?? 'error'}: ${body.error?.message ?? 'the turn failed'}`,
        }]);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'error', text: `request failed: ${e.message}` }]);
    } finally {
      setPending(false);
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
    } else if (body.error?.kind === 'workspace-collision') {
      setAuthError({ kind: 'auth', message: body.error.message });
    }
  }

  // ── view derivation ──────────────────────────────────────────────────────
  let view;
  if (authError) view = 'auth';
  else if (offlineError) view = 'offline';
  else if (!status) view = 'loading';
  else if (status.state === 'connect-smartmemory') view = 'connect-smartmemory';
  else if (status.state === 'offline') view = 'offline';
  else if (status.state === 'workspace-collision') view = 'workspace-collision';
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

        {/* body */}
        {view === 'loading' && (
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
            checking Maya…
          </div>
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
          <FunnelCard icon={ShieldAlert} title="Refusing this token: workspace collision">
            The colleague token&apos;s workspace claim IS the fluid workspace. Accepting
            it would let Maya&apos;s background ingestion write into the fluid records
            (deep binding — deferred, and never enabled by accident). Provision a
            dedicated colleague identity or paste a token scoped elsewhere.
            {status?.error && <div className="mt-1 font-mono text-[10px]">{status.error}</div>}
          </FunnelCard>
        )}

        {view === 'auth' && (
          <FunnelCard
            icon={KeyRound}
            title="Maya rejected the colleague credential"
            actions={
              <>
                <FunnelAction
                  onClick={reprovision}
                  sub="starts a fresh conversation — her accumulated colleague memory is lost"
                >
                  re-provision
                </FunnelAction>
                {!pasting && (
                  <FunnelAction onClick={() => setPasting(true)} sub="keeps whatever identity the token carries">
                    paste a new token
                  </FunnelAction>
                )}
              </>
            }
          >
            The token was refused after one retry. A 401 does not prove expiry, and
            re-provisioning destroys the standing thread — both recoveries are explicit,
            never automatic.
            {authError?.message && <div className="mt-1 font-mono text-[10px]">{authError.message}</div>}
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
              {pending && (
                <div className="text-[11px] animate-pulse" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Maya is thinking…
                </div>
              )}
            </div>
            <ChatInput onSend={send} disabled={pending} placeholder="Message Maya…" />
          </>
        )}
      </div>
    </div>
  );
}
