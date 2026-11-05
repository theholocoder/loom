// The Session header's Merge request: opening it on the Forge; the Merge
// request action, a prompt shortcut asking the agent to open or update it;
// and Link Merge request, for linking one by hand.
import { ChevronDown, ExternalLink, GitPullRequest, GitPullRequestArrow, GitPullRequestCreate, Link } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { mergeRequestRef, type ForgeKind, type Project, type Session } from '../shared/api';
import { useApi } from './api';
import { Popover } from './Popover';

/**
 * The header's Merge request: with one linked, a button showing its number
 * whose menu opens it, asks the agent to update it, or links another; with
 * none, Create Merge request and Link Merge request. Asking and linking need
 * a Session that can take a prompt, on a Project whose Forge is on: without,
 * the linked one's button just opens it. `linkRequest` changing opens the
 * Link Merge request popover, as the palette does.
 */
export function MergeRequestActions({ session, project, linkRequest = 0, onError }: { session: Session; project: Project | undefined; linkRequest?: number; onError: (message: string | undefined) => void }) {
  const api = useApi();
  const [menu, setMenu] = useState(false);
  const [linking, setLinking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const canAct = session.status !== 'archived' && !session.worktreeMissing && project?.forge.state === 'available';
  useEffect(() => {
    if (linkRequest && canAct) {
      setMenu(false);
      setLinking(true);
    }
  }, [linkRequest]);
  const { mergeRequest } = session;
  if (!mergeRequest && !canAct) return null;
  const ref = mergeRequest && mergeRequestRef(project?.forge.kind, mergeRequest.number);
  const openIt = () => mergeRequest && void api.invoke('links.open', { url: mergeRequest.url }).catch(() => {});
  const ask = () => {
    onError(undefined);
    api.invoke('sessions.requestMergeRequest', { id: session.id }).catch((e: unknown) => onError((e as Error).message));
  };
  const item = (label: string, icon: ReactNode, run: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setMenu(false);
        run();
      }}
    >
      {icon}
      {label}
    </button>
  );
  const linkPopover = linking && <LinkMergeRequest session={session} anchor={trigger} onClose={() => setLinking(false)} />;

  if (mergeRequest && ref) {
    const label = `Merge request ${ref}`;
    if (!canAct)
      return (
        <button className="icon-btn mr-btn tech" type="button" title={label} aria-label={label} onClick={openIt}>
          <GitPullRequest />
          {ref}
        </button>
      );
    return (
      <>
        <button ref={trigger} className="icon-btn mr-btn tech" type="button" title={label} aria-label={label} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <GitPullRequest />
          {ref}
          <ChevronDown className="sm chev" aria-hidden />
        </button>
        {menu && (
          <Popover anchor={trigger} role="menu" label={label} onClose={() => setMenu(false)}>
            {item(`Open ${ref}`, <ExternalLink className="sm" />, openIt)}
            {item('Update Merge request', <GitPullRequestArrow className="sm" />, ask)}
            {item('Link another Merge request…', <Link className="sm" />, () => setLinking(true))}
          </Popover>
        )}
        {linkPopover}
      </>
    );
  }
  return (
    <>
      <button className="icon-btn" type="button" title="Create Merge request" aria-label="Create Merge request" onClick={ask}>
        <GitPullRequestCreate />
      </button>
      <button ref={trigger} className="icon-btn" type="button" title="Link Merge request" aria-label="Link Merge request" aria-haspopup="dialog" aria-expanded={linking} onClick={() => setLinking(!linking)}>
        <Link />
      </button>
      {linkPopover}
    </>
  );
}

/** A number or URL to link, checked on the Forge; what went wrong shows in the popover. */
function LinkMergeRequest({ session, anchor, onClose }: { session: Session; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const api = useApi();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [linking, setLinking] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || linking) return;
    setLinking(true);
    setError(undefined);
    try {
      await api.invoke('sessions.linkMergeRequest', { id: session.id, mergeRequest: value.trim() });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinking(false);
    }
  };
  return (
    <Popover anchor={anchor} role="dialog" label="Link Merge request" className="link-mr" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          <span>Merge request number or URL</span>
          <input data-autofocus aria-label="Merge request number or URL" className="tech" placeholder="12, or its URL" value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {error && (
          <div className="err" role="alert">
            {error}
          </div>
        )}
        <button className="primary" type="submit" disabled={!value.trim() || linking}>
          Link
        </button>
      </form>
    </Popover>
  );
}
