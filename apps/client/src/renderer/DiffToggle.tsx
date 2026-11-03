import { FileDiff } from 'lucide-react';
import type { DiffStat } from '../shared/api';

/** The spoken form of a diff stat, e.g. "4 files, 1210 added, 3 removed". */
export function diffStatLabel(stat: DiffStat): string {
  return `${stat.files} ${stat.files === 1 ? 'file' : 'files'}, ${stat.added} added, ${stat.removed} removed`;
}

/**
 * The Session header's diff control: file count and +/− on one line, toggling
 * the diff panel. Only the icon shows until there is something to count.
 */
export function DiffToggle({ stat, open, onToggle }: { stat?: DiffStat; open: boolean; onToggle: () => void }) {
  const counted = stat && stat.files > 0 ? stat : undefined;
  const verb = open ? 'Hide changes' : 'Show changes';
  const label = counted ? `${verb}: ${diffStatLabel(counted)}` : verb;
  return (
    <button className="icon-btn diff-stat-btn" type="button" title={label} aria-label={label} aria-expanded={open} aria-controls="diff-panel" onClick={onToggle}>
      <FileDiff />
      {counted ? (
        <span className="diff-stat" aria-hidden="true">
          <span className="files">{counted.files}</span>
          <span className="add">+{counted.added}</span>
          <span className="del">−{counted.removed}</span>
        </span>
      ) : null}
    </button>
  );
}
