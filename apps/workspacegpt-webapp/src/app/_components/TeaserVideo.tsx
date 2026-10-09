"use client";

import { useState } from "react";

const VIDEO_ID = "8STb3IY4PJ4";

/**
 * Click-to-play YouTube embed. Nothing from YouTube loads (no iframe, no
 * thumbnail, no cookies) until the visitor presses play, which keeps the page
 * consistent with its own privacy pitch. The nocookie host is used once it does.
 */
export function TeaserVideo() {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-line bg-background shadow-2xl">
      {playing ? (
        <iframe
          className="absolute inset-0 h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${VIDEO_ID}?autoplay=1&rel=0`}
          title="WorkspaceGPT Desktop — 30 second teaser"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label="Play the 30 second WorkspaceGPT Desktop teaser"
          className="group absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(ellipse_at_30%_20%,rgba(31,242,180,0.14),transparent_60%),radial-gradient(ellipse_at_80%_90%,rgba(167,139,250,0.14),transparent_55%)]"
        >
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-brand text-black shadow-lg transition-transform group-hover:scale-105">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
          <span className="text-sm font-medium text-muted">Watch the 30-second teaser</span>
        </button>
      )}
    </div>
  );
}
