import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

function renderApp() {
  const main = new FakeMain();
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const inbox = () => screen.getByRole('complementary', { name: 'Inbox' });
const restart = () => within(inbox()).queryByRole('button', { name: /Restart to update/ });

describe('an update downloaded', () => {
  it('offers "Restart to update" in the sidebar footer, naming the version, and restarts on click', () => {
    const main = renderApp();
    expect(restart()).toBeNull();

    act(() => main.publish('update', { state: 'ready', version: '1.2.0' }));
    const button = within(within(inbox()).getByRole('navigation')).getByRole('button', { name: /Restart to update/ });
    expect(button.title).toContain('1.2.0');
    fireEvent.click(button);
    expect(main.invoked.filter((i) => i.command === 'update.restart')).toHaveLength(1);
  });

  it('is offered in the collapsed Inbox too', () => {
    const main = renderApp();
    act(() => main.publish('update', { state: 'ready', version: '1.2.0' }));
    fireEvent.click(within(inbox()).getByRole('button', { name: 'Collapse the Inbox' }));
    fireEvent.click(restart()!);
    expect(main.invoked.filter((i) => i.command === 'update.restart')).toHaveLength(1);
  });
});
