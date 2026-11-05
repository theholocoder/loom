// The Session header's Merge request: its chip, which opens it on the Forge;
// the Merge request action, a prompt shortcut asking the agent to open or
// update it; and Link Merge request, for linking one by hand.
import { GitPullRequest, GitPullRequestArrow, GitPullRequestCreate, Link } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { mergeRequestRef, type ForgeKind, type Project, type Session } from '../shared/api';
import { useApi } from './api';
import { Popover } from './Popover';

/** The linked Merge request's number, opening it on the Forge. */
export function MergeRequestChip({ session, forge }: { session: Session; forge: ForgeKind | undefined }) {
  const api = useApi();
  const { mergeRequest } = session;
  if (!mergeRequest) return null;
  return (
    <button type="button" className="chip tech" title="Merge request" aria-label={`Merge request ${mergeRequestRef(forge, mergeRequest.number)}`} onClick={() => void api.invoke('links.open', { url: mergeRequest.url }).catch(() => {})}>
      <GitPullRequest className="sm" />
      {mergeRequestRef(forge, mergeRequest.number)}
    </button>
  );
}

/**
 * The header's Merge request actions, for a Session that can take a prompt
 * on a Project whose Forge is on. `linkRequest` changing opens the Link
 * Merge request popover, as the palette does.
 */
export function MergeRequestActions({ session, project, linkRequest = 0, onError }: { session: Session; project: Project | undefined; linkRequest?: number; onError: (message: string | undefined) => void }) {
  const api = useApi();
  const [linking, setLinking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (linkRequest) setLinking(true);
  }, [linkRequest]);
  if (session.status === 'archived' || session.worktreeMissing || project?.forge.state !== 'available') return null;
  const { mergeRequest } = session;
  const label = mergeRequest ? `Update Merge request ${mergeRequestRef(project.forge.kind, mergeRequest.number)}` : 'Create Merge request';
  const ask = () => {
    onError(undefined);
    api.invoke('sessions.requestMergeRequest', { id: session.id }).catch((e: unknown) => onError((e as Error).message));
  };
  return (
    <>
      <button className="icon-btn" type="button" title={label} aria-label={label} onClick={ask}>
        {mergeRequest ? <GitPullRequestArrow /> : <GitPullRequestCreate />}
      </button>
      <button ref={trigger} className="icon-btn" type="button" title="Link Merge request" aria-label="Link Merge request" aria-haspopup="dialog" aria-expanded={linking} onClick={() => setLinking(!linking)}>
        <Link />
      </button>
      {linking && <LinkMergeRequest session={session} anchor={trigger} onClose={() => setLinking(false)} />}
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
