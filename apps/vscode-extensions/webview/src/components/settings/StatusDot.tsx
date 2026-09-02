import React from 'react';

/**
 * Small coloured dot for section summaries — replaces the ✅ emoji, which
 * rendered differently on every platform and was the loudest thing on an
 * otherwise quiet header row.
 */
const StatusDot: React.FC<{ tone: 'ok' | 'warn' | 'off' }> = ({ tone }) => (
  <span className={`status-dot status-dot--${tone}`} aria-hidden='true' />
);

export default StatusDot;
