// Snoozing a Waiting Session: the menu of times its Inbox row offers, and
// how a snooze's end is written.
import { AlarmClock } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '../shared/api';
import { useApi } from './api';
import { Popover } from './Popover';

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** The hour "Tomorrow" and "Next week" come back at. */
const MORNING = 9;

/** Whether the Session is Snoozed: Waiting, out of the Inbox until its snooze ends. */
export function isSnoozed(session: Session): boolean {
  return session.status === 'waiting' && session.snoozedUntil !== undefined;
}

/** The snooze times offered first, as of `now`: in 1 and 3 hours, tomorrow and next Monday at 9:00. */
export function snoozePresets(now: number): Array<{ label: string; until: number }> {
  const morningIn = (days: number) => {
    const day = new Date(now);
    day.setDate(day.getDate() + days);
    return day.setHours(MORNING, 0, 0, 0);
  };
  // The Monday after today: a week away on a Monday.
  const toMonday = (8 - new Date(now).getDay()) % 7 || 7;
  return [
    { label: '1 hour', until: now + HOUR },
    { label: '3 hours', until: now + 3 * HOUR },
    { label: 'Tomorrow', until: morningIn(1) },
    { label: 'Next week', until: morningIn(toMonday) },
  ];
}

/** When a snooze ends: the time today, "Tomorrow" and the time, the weekday and time within the week, else the date and time. */
export function wakeTime(until: number, now: number): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(until) - day(now)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * A Waiting Session's Snooze button and its menu. `onOpenChange` says while
 * the menu is open, so the row keeps its actions showing; `onError` says why
 * a snooze failed.
 */
export function SnoozeButton({ session, onOpenChange, onError }: { session: Session; onOpenChange: (open: boolean) => void; onError: (message: string) => void }) {
  const api = useApi();
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<'presets' | 'custom'>();
  const show = (next: typeof menu) => {
    setMenu(next);
    onOpenChange(next !== undefined);
  };
  const snooze = (until: number) => {
    show(undefined);
    api.invoke('sessions.snooze', { id: session.id, until }).catch((e: unknown) => onError((e as Error).message));
  };
  const now = Date.now();
  return (
    <>
      <button ref={trigger} className="icon-btn sm" type="button" title="Snooze" aria-label="Snooze" aria-haspopup="menu" aria-expanded={menu !== undefined} onClick={() => show(menu ? undefined : 'presets')}>
        <AlarmClock />
      </button>
      {/* On the body: a fixed popover inside the row's actions would be placed against them, as they are transformed. */}
      {menu === 'presets' &&
        createPortal(
          <Popover anchor={trigger} role="menu" label="Snooze" onClose={() => show(undefined)}>
            {snoozePresets(now).map(({ label, until }) => (
              <button key={label} type="button" role="menuitem" aria-label={label} onClick={() => snooze(until)}>
                <span className="grow">{label}</span>
                <span className="muted">{wakeTime(until, now)}</span>
              </button>
            ))}
            <button type="button" role="menuitem" aria-label="Custom…" onClick={() => show('custom')}>
              Custom…
            </button>
          </Popover>,
          document.body,
        )}
      {menu === 'custom' &&
        createPortal(
          <Popover anchor={trigger} role="dialog" label="Snooze" className="snooze-custom" onClose={() => show(undefined)}>
            <CustomSnooze now={now} onSnooze={snooze} />
          </Popover>,
          document.body,
        )}
    </>
  );
}

/** Two digits, for a date or time input's value. */
const pad = (n: number) => String(n).padStart(2, '0');

/** A snooze until a date and time, or for a duration; it must end in the future. */
function CustomSnooze({ now, onSnooze }: { now: number; onSnooze: (until: number) => void }) {
  const inAnHour = new Date(now + HOUR);
  const [mode, setMode] = useState<'until' | 'for'>('until');
  const [date, setDate] = useState(`${inAnHour.getFullYear()}-${pad(inAnHour.getMonth() + 1)}-${pad(inAnHour.getDate())}`);
  const [time, setTime] = useState(`${pad(inAnHour.getHours())}:${pad(inAnHour.getMinutes())}`);
  const [hours, setHours] = useState('1');
  const [minutes, setMinutes] = useState('0');
  const until = mode === 'until' ? untilAt(date, time) : untilAfter(Date.now(), hours, minutes);
  const valid = until !== undefined && until > Date.now();
  return (
    <form
      className="snooze-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSnooze(until);
      }}
    >
      <div className="snooze-modes" role="radiogroup" aria-label="Snooze by">
        {(['until', 'for'] as const).map((value) => (
          <label key={value} className={mode === value ? 'on' : undefined}>
            <input type="radio" name="snooze-mode" checked={mode === value} onChange={() => setMode(value)} />
            {value === 'until' ? 'Until' : 'For'}
          </label>
        ))}
      </div>
      {mode === 'until' ? (
        <div className="row">
          <input type="date" aria-label="Date" value={date} autoFocus onChange={(e) => setDate(e.target.value)} />
          <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      ) : (
        <div className="row">
          <input type="number" aria-label="Hours" min={0} value={hours} autoFocus onChange={(e) => setHours(e.target.value)} />
          <span className="muted">h</span>
          <input type="number" aria-label="Minutes" min={0} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          <span className="muted">min</span>
        </div>
      )}
      <button type="submit" className="primary" disabled={!valid}>
        Snooze
      </button>
    </form>
  );
}

/** The clock time of a date input's and a time input's values, local time; undefined unless both are whole. */
function untilAt(date: string, time: string): number | undefined {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return undefined;
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])).getTime();
}

/** `now` plus the hours and minutes given; undefined unless both are whole numbers, none negative. */
function untilAfter(now: number, hours: string, minutes: string): number | undefined {
  const h = Number(hours || 0);
  const m = Number(minutes || 0);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0) return undefined;
  return now + h * HOUR + m * MINUTE;
}
