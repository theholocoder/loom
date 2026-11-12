// The Merge request Panel's Diff tab: what the Merge request changes, as its
// Forge has it, drawn as the Changes Panel draws a diff (its file tree, its
// layout toggles, comments to the agent on its lines), read when the tab
// shows, again after each Babysit poll and on the Panel's refresh.
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, FORGE_NAMES, type DiffFile, type ForgeKind, type MergeRequestDiff, type Session } from '../shared/api';
import { useApi, useTopic } from './api';
import { DiffFiles, DiffViewToggles, useDiffView, useWide, WIDE_CHANGES_PX, type DiffComments } from './Changes';

/**
 * The diff of `session`'s Merge request, read again when `generation`
 * changes. Its lines can be commented on while `comments` is given.
 */
export function MergeRequestDiffView({ session, forge, generation, comments, onRefresh }: { session: Session; forge: ForgeKind | undefined; generation: number; comments: DiffComments | undefined; onRefresh: () => void }) {
  const settings = useTopic('settings');
  const [view, changeView] = useDiffView(settings?.diffView);
  const root = useRef<HTMLDivElement>(null);
  const wide = useWide(root, WIDE_CHANGES_PX);
  const read = useMergeRequestDiff(session, generation);
  const forgeName = forge ? FORGE_NAMES[forge] : 'the Forge';
  const diff = read.diff;
  const byPath = new Map(diff?.files.map((file) => [file.path, file]));
  return (
    <div className="changes mr-diff" ref={root}>
      <div className="changes-bar" role="toolbar" aria-label="Merge request diff">
        {diff?.moreFiles && <span className="muted more-files">{`${forgeName} listed only the first ${diff.files.length} files.`}</span>}
        <span className="grow" />
        <DiffViewToggles view={view} onChange={changeView} />
      </div>
      {read.error && (
        <p className="err mr-diff-error" role="alert">
          {`Couldn't read the diff from ${forgeName}: ${read.error}`}{' '}
          <button type="button" className="link" onClick={onRefresh}>
            Try again
          </button>
        </p>
      )}
      {!diff ? (
        !read.error && (
          <div className="scroll">
            <div className="diff-loading" role="status">
              Reading the diff from {forgeName}…
            </div>
          </div>
        )
      ) : diff.files.length === 0 ? (
        <div className="scroll">
          <div className="empty">This Merge request changes no file.</div>
        </div>
      ) : (
        <DiffFiles
          files={diff.files}
          read={(file: DiffFile) => {
            const found = byPath.get(file.path);
            return found ? Promise.resolve({ text: found.text, truncated: found.truncated }) : Promise.reject(new Error(`${file.path} is no longer in the diff.`));
          }}
          version={String(read.at)}
          comments={comments}
          wide={wide}
          patterns={settings?.diffCollapsedPatterns ?? []}
          theme={settings?.theme ?? DEFAULT_SETTINGS.theme}
          view={view}
          onViewChange={changeView}
        />
      )}
    </div>
  );
}

/** The diff last read of the Session's Merge request, read again on a new link, after each Babysit poll, and on a new `generation`. */
function useMergeRequestDiff(session: Session, generation: number): { diff?: MergeRequestDiff; error?: string; at?: number } {
  const api = useApi();
  const url = session.mergeRequest?.url;
  const [read, setRead] = useState<{ url: string; diff?: MergeRequestDiff; error?: string; at?: number }>();
  useEffect(() => {
    if (!url) return;
    let current = true;
    api.invoke('sessions.mergeRequestDiff', { id: session.id }).then(
      (diff) => current && setRead({ url, diff, at: Date.now() }),
      // What was read before stays, under why it couldn't be read again.
      (e: unknown) => current && setRead((was) => ({ ...(was?.url === url ? was : { url }), error: (e as Error).message })),
    );
    return () => {
      current = false;
    };
  }, [api, session.id, url, session.babysit?.lastPollAt, generation]);
  // Not what was read of a Merge request linked before.
  return read && read.url === url ? read : {};
}
