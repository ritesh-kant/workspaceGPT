import React from 'react';
import { isDesktopHost } from '../vscode';
import KnowledgeLine from './KnowledgeLine';

interface HomeGreetingProps {
  /**
   * Chat mode leaves docs, tickets and the codebase out of reach, so the
   * usual "knows your whole org" line would be advertising something this
   * session genuinely cannot do.
   */
  chatOnly?: boolean;
  /**
   * Opens Settings on a page. With it, on the desktop, the subtitle becomes
   * the knowledge line: which org sources the agent knows right now, each a
   * link to its Settings page (KnowledgeLine).
   */
  onOpenSettings?: (page: string) => void;
}

/**
 * One-line greeting strip for the chat empty state.
 *
 * Deliberately small: the greeting establishes what the product is without
 * competing for space with "Your work" — the dynamic content the user actually
 * acts on. The mark is an inline SVG rather than an emoji so it renders the
 * same on every platform and sits in the theme's accent colour.
 */
const HomeGreeting: React.FC<HomeGreetingProps> = ({ chatOnly = false, onOpenSettings }) => {
  const knowledge = !chatOnly && onOpenSettings && isDesktopHost();
  return (
    <div className='home-greeting'>
      <span className='home-greeting-mark' aria-hidden='true'>
        <svg width='16' height='16' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
          <path
            d='M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z'
            fill='currentColor'
          />
          <path d='M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z' fill='currentColor' opacity='0.7' />
        </svg>
      </span>
      <div className='home-greeting-text'>
        <span className='home-greeting-title'>Hello</span>
        {knowledge ? (
          <KnowledgeLine onOpen={onOpenSettings} />
        ) : (
          <span className='home-greeting-subtitle'>
            {chatOnly
              ? 'A plain chat — your docs, tickets and code stay out of it. Switch to Work when you need them.'
              : 'The coding agent that knows your whole org — docs, tickets, and code.'}
          </span>
        )}
      </div>
    </div>
  );
};

export default HomeGreeting;
