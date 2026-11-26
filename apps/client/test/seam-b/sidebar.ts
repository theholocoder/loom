import { fireEvent, screen, within } from '@testing-library/react';

/**
 * Opens the Session titled `title` from its sidebar card, first expanding
 * the collapsed section it sits in (Pending approval, Archived) when its card
 * isn't in the Inbox.
 */
export function openFromSidebar(title: string): void {
  const inbox = within(screen.getByRole('complementary', { name: 'Inbox' }));
  for (const section of ['Pending approval', 'Archived']) {
    if (inbox.queryByRole('button', { name: title })) break;
    const head = inbox.queryByRole('button', { name: section });
    if (head?.getAttribute('aria-expanded') === 'false') fireEvent.click(head);
  }
  fireEvent.click(inbox.getByRole('button', { name: title }));
}
