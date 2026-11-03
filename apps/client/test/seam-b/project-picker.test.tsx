import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { Project } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

const project = (id: number, name: string, path: string): Project => ({
  id,
  name,
  branchPrefix: 'loom',
  checkout: { environmentId: 'native', path },
  forge: { state: 'no-remote', checking: false },
});
const projects = [project(1, 'billing-api', '/home/dev/billing-api'), project(2, 'web-shop', '/home/dev/shop'), project(3, 'docs', '/srv/handbook')];

function openPicker(list: Project[] = projects) {
  render(
    <ApiProvider api={new FakeMain({ projects: list })}>
      <App />
    </ApiProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
  return screen.queryByRole('dialog', { name: 'Pick a Project' });
}

const filter = () => screen.getByRole('combobox', { name: 'Filter Projects' });
const rows = () => screen.getAllByRole('option');
const names = () => rows().map((row) => row.querySelector('.picker-name')?.textContent);
const highlighted = () => {
  const id = filter().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.querySelector('.picker-name')?.textContent : undefined;
};

describe('the Project picker for a new Session', () => {
  it('opens as a centred modal with its filter focused', () => {
    const dialog = openPicker()!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.classList).toContain('picker-modal');
    expect(dialog.parentElement!.classList).toContain('scrim');
    expect(document.activeElement).toBe(filter());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('main', { name: 'New Session' })).toBeNull();
  });

  it("shows each Project's avatar, name and path, the first one highlighted", () => {
    openPicker();
    const first = rows()[0]!;
    expect(first.querySelector('.proj-avatar')?.textContent).toBe('BI');
    expect(within(first).getByText('billing-api')).toBeTruthy();
    expect(within(first).getByText('/home/dev/billing-api').classList).toContain('tech');
    expect(names()).toEqual(['billing-api', 'web-shop', 'docs']);
    expect(highlighted()).toBe('billing-api');
    expect(first.getAttribute('aria-selected')).toBe('true');
  });

  it('filters by name and by path, case-insensitively, highlighting the first match', () => {
    openPicker();
    fireEvent.keyDown(filter(), { key: 'ArrowDown' });
    fireEvent.keyDown(filter(), { key: 'ArrowDown' });
    expect(highlighted()).toBe('docs');
    fireEvent.change(filter(), { target: { value: 'DEV' } });
    expect(names()).toEqual(['billing-api', 'web-shop']);
    expect(highlighted()).toBe('billing-api');
    fireEvent.change(filter(), { target: { value: 'SHOP' } });
    expect(names()).toEqual(['web-shop']);
    expect(highlighted()).toBe('web-shop');

    fireEvent.change(filter(), { target: { value: 'handbook' } });
    expect(names()).toEqual(['docs']);

    fireEvent.change(filter(), { target: { value: 'nothing' } });
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByText('No matching Project.')).toBeTruthy();
    fireEvent.keyDown(filter(), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Pick a Project' })).toBeTruthy();
    expect(screen.queryByRole('main', { name: 'New Session' })).toBeNull();
  });

  it('moves the highlight with the arrow keys, stopping at the ends, and Enter starts the Session with that Project', () => {
    openPicker();
    fireEvent.keyDown(filter(), { key: 'ArrowUp' });
    expect(highlighted()).toBe('billing-api');
    fireEvent.keyDown(filter(), { key: 'ArrowDown' });
    fireEvent.keyDown(filter(), { key: 'ArrowDown' });
    fireEvent.keyDown(filter(), { key: 'ArrowDown' });
    expect(highlighted()).toBe('docs');
    fireEvent.keyDown(filter(), { key: 'ArrowUp' });
    expect(highlighted()).toBe('web-shop');

    fireEvent.keyDown(filter(), { key: 'Enter' });

    expect(screen.queryByRole('dialog', { name: 'Pick a Project' })).toBeNull();
    const pane = screen.getByRole('main', { name: 'New Session' });
    expect(within(pane).getByRole('button', { name: 'Project' }).textContent).toBe('web-shop');
  });

  it('picks with the mouse too', () => {
    openPicker();
    fireEvent.mouseMove(rows()[2]!);
    expect(highlighted()).toBe('docs');
    fireEvent.click(rows()[2]!);
    expect(within(screen.getByRole('main', { name: 'New Session' })).getByRole('button', { name: 'Project' }).textContent).toBe('docs');
  });

  it('starts over with the newly picked Project when already on New Session', () => {
    openPicker();
    fireEvent.keyDown(filter(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Session' }));
    fireEvent.change(filter(), { target: { value: 'docs' } });
    fireEvent.keyDown(filter(), { key: 'Enter' });
    expect(within(screen.getByRole('main', { name: 'New Session' })).getByRole('button', { name: 'Project' }).textContent).toBe('docs');
  });

  it('closes on Escape, leaving the view as it was and focus on the New button', () => {
    openPicker();
    fireEvent.keyDown(filter(), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Pick a Project' })).toBeNull();
    expect(screen.queryByRole('main', { name: 'New Session' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New' }));
  });

  it('closes on a click on the backdrop', () => {
    const dialog = openPicker()!;
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.queryByRole('dialog', { name: 'Pick a Project' })).toBeNull();
  });

  it('goes straight to New Session, which asks for a Project, when there are none', () => {
    expect(openPicker([])).toBeNull();
    expect(within(screen.getByRole('main', { name: 'New Session' })).getByText('Add a Project before starting a Session.')).toBeTruthy();
  });
});
