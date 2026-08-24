import React from 'react';

/**
 * One-line greeting strip for the chat empty state.
 *
 * Deliberately small: the greeting establishes what the product is without
 * competing for space with "Your work" and recent chats — the dynamic content
 * the user actually acts on. The old full-height hero pushed everything below
 * the fold once the work panel had real tickets in it.
 */
const HomeGreeting: React.FC = () => (
  <div className='home-greeting'>
    <span className='home-greeting-wave'>👋</span>
    <div className='home-greeting-text'>
      <span className='home-greeting-title'>Hello</span>
      <span className='home-greeting-subtitle'>
        The coding agent that knows your whole org — docs, tickets, and code.
      </span>
    </div>
  </div>
);

export default HomeGreeting;
