/**
 * SecurityBanner.jsx — COMP-COCKPIT-NOTIFY-CHIP-1: a full-width red strip under the header while any security row
 * (owner-queue tag SECURITY or CREDENTIAL) is open. Not dismissible in phase 1: it leaves when the owner queue clears the row.
 */
import React from 'react';
import { useNotifySources } from './useNotifySources.js';
import { bannerText } from './notifyLogic.js';
import { openInbox } from './NotifyChip.jsx';

export default function SecurityBanner({ onOpenFleet }) {
  const { collected } = useNotifySources();
  const banner = bannerText(collected);
  if (!banner) return null;
  return (
    <div
      data-testid="security-banner"
      role="alert"
      className="shrink-0 flex items-center gap-3 px-3 py-1 text-xs font-semibold"
      style={{ background: 'hsl(var(--destructive))', color: 'white' }}
    >
      <span className="min-w-0 flex-1 truncate" title={banner.text}>{banner.text}</span>
      {banner.more > 0 && <span data-testid="security-banner-more" className="whitespace-nowrap">+{banner.more} more</span>}
      <button type="button" data-testid="security-banner-open" className="underline underline-offset-2 whitespace-nowrap" onClick={() => openInbox(onOpenFleet)}>
        Open inbox
      </button>
    </div>
  );
}
