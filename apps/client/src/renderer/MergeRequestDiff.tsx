// The Merge request Panel's Diff tab: what the Merge request changes, as its
// Forge has it, drawn as the Changes Panel draws a diff (its file tree, its
// layout toggles, comments to the agent on its lines, its review threads as
// notes), read when the tab shows, again after each Babysit poll and on the
// Panel's refresh.
import { useRef } from 'react';
import { FORGE_NAMES, type DiffFile, type ForgeKind, type Session } from '../shared/api';
import { useTopic } from './api';
import { useTheme } from './appearance';
import { DiffFiles, DiffViewToggles, useDiffView, useWide, WIDE_CHANGES_PX, type DiffComments } from './Changes';
import { useMergeRequestRead } from './forge-read';
import type { ReviewNotes } from './ReviewNotes';

/**
 * The diff of `session`'s Merge request, read again when `generation`
 * changes. Its lines can be commented on while `comments` is given; the
 * review threads in `reviews` show as notes on their lines.
 */
export function MergeRequestDiffView({
  session,
  forge,
  generation,
  comments,
  reviews,
  onRefresh,
}: {
  session: Session;
  forge: ForgeKind | undefined;
  generation: number;
  comments: DiffComments | undefined;
  reviews?: ReviewNotes;
  onRefresh: () => void;
}) {
  const settings = useTopic('settings');
  const theme = useTheme();
  const [view, changeView] = useDiffView(settings?.diffView);
  const root = useRef<HTMLDivElement>(null);
  const wide = useWide(root, WIDE_CHANGES_PX);
  const read = useMergeRequestRead('sessions.mergeRequestDiff', session, generation);
  const forgeName = forge ? FORGE_NAMES[forge] : 'the Forge';
  const diff = read.value;
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
          reviews={reviews}
          wide={wide}
          patterns={settings?.diffCollapsedPatterns ?? []}
          theme={theme}
          view={view}
          onViewChange={changeView}
        />
      )}
    </div>
  );
}
