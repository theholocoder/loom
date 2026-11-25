import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

function renderApp(main: FakeMain) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const form = () => screen.getByRole('dialog', { name: 'Send feedback' });

describe('the feedback form', () => {
  it('opens from the Inbox footer, and sends what the user wrote as a bug or an idea, with an email address if given', async () => {
    const main = renderApp(new FakeMain());
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: 'Send feedback' }));

    const send = within(form()).getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(within(form()).getByRole('radio', { name: 'Something went wrong' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(form()).getByRole('radio', { name: 'An idea' }));
    fireEvent.change(within(form()).getByRole('textbox', { name: 'Your feedback' }), { target: { value: 'Group Sessions by label' } });
    fireEvent.change(within(form()).getByRole('textbox', { name: /Your email address/ }), { target: { value: 'dev@example.com' } });
    fireEvent.click(send);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Send feedback' })).toBeNull());
    expect(main.invoked.filter((i) => i.command === 'feedback.send').map((i) => i.params)).toEqual([{ kind: 'idea', message: 'Group Sessions by label', email: 'dev@example.com' }]);
    expect(screen.getByText('Thanks: your feedback was sent')).toBeTruthy();
  });

  it('keeps what was written, and says why, when it could not be sent', async () => {
    renderApp(
      new FakeMain(
        {},
        {
          'feedback.send': () => {
            throw new Error('this build of Loom sends no feedback');
          },
        },
      ),
    );
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: 'Send feedback' }));
    fireEvent.change(within(form()).getByRole('textbox', { name: 'Your feedback' }), { target: { value: 'The Inbox froze' } });
    fireEvent.click(within(form()).getByRole('button', { name: 'Send' }));

    expect((await within(form()).findByRole('alert')).textContent).toContain('this build of Loom sends no feedback');
    expect((within(form()).getByRole('textbox', { name: 'Your feedback' }) as HTMLTextAreaElement).value).toBe('The Inbox froze');
  });

  it('closes on Cancel without sending', () => {
    const main = renderApp(new FakeMain());
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Inbox' })).getByRole('button', { name: 'Send feedback' }));
    fireEvent.click(within(form()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Send feedback' })).toBeNull();
    expect(main.invoked.some((i) => i.command === 'feedback.send')).toBe(false);
  });
});
