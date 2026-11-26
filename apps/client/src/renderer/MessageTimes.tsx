// When a conversation's messages were said: each one's time, and the day
// above the first one said on it.
import { Fragment, type ReactNode } from 'react';
import { useDates } from './dates';
import { useNow } from './now';

/** The time a message was said, its date in full in its tooltip; nothing for one from before Loom kept it. */
export function MessageTime({ at }: { at: number | undefined }) {
  const dates = useDates();
  if (at === undefined) return null;
  return (
    <time className="msg-time" dateTime={new Date(at).toISOString()} title={dates.full(at)}>
      {dates.time(at)}
    </time>
  );
}

/** The day the messages under it were said: "Today", "Yesterday", "Mon, 9 Nov". */
function DayDivider({ at }: { at: number }) {
  const dates = useDates();
  const heading = dates.dayHeading(at, useNow());
  return (
    <div className="day-divider" role="separator" aria-label={heading}>
      <span>{heading}</span>
    </div>
  );
}

/**
 * Shows each of a conversation's parts with `show`, the day above the first
 * one said on it. `when` gives when a part was said, for one that keeps it.
 */
export function withDays<P>(parts: P[], when: (part: P) => number | undefined, show: (part: P, index: number, parts: P[]) => ReactNode): ReactNode[] {
  let day: number | undefined;
  return parts.map((part, index) => {
    const shown = show(part, index, parts);
    const at = when(part);
    if (at === undefined) return shown;
    const its = new Date(at).setHours(0, 0, 0, 0);
    if (its === day) return shown;
    day = its;
    return (
      <Fragment key={`day-${its}`}>
        <DayDivider at={at} />
        {shown}
      </Fragment>
    );
  });
}
