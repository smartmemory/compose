import React, { useCallback, useState } from 'react';

export default function InteractiveSessionCard({ session }) {
  const { active, sessionId, sending, sendMessage } = session;
  const [text, setText] = useState('');
  const [error, setError] = useState(null);

  const handleSend = useCallback(async (e) => {
    e?.preventDefault();
    if (!text.trim()) return;
    setError(null);
    try {
      await sendMessage(text);
      setText('');
    } catch (err) {
      setError(err.message);
    }
  }, [text, sendMessage]);

  return (
    <div className="m-session-card" data-testid="mobile-interactive-session">
      <div className="m-session-card-row">
        <div className="m-session-card-title">Interactive session</div>
        <span
          className="m-status-pill"
          data-status={active ? 'in_progress' : 'planned'}
        >
          {active ? 'active' : 'idle'}
        </span>
      </div>
      <div className="m-session-card-id">
        {sessionId ? `id: ${sessionId}` : 'No active session'}
      </div>
      <form className="m-session-card-form" onSubmit={handleSend}>
        <input
          type="text"
          className="m-input"
          placeholder={active ? 'Message Claude…' : 'Start a new session…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="mobile-interactive-session-input"
          disabled={sending}
        />
        <button
          type="submit"
          className="m-btn m-btn-primary m-btn-sm"
          disabled={sending || !text.trim()}
          data-testid="mobile-interactive-session-send"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      {error && <div className="m-agent-card-error">{error}</div>}
    </div>
  );
}
