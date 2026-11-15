import { fireEvent, screen, within } from '@testing-library/react';

/** Goes to Settings' page `name` (Settings open), from the list of its sections. */
export function settingsPage(name: string): void {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('link', { name }));
}
