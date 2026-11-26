import { Check } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { LoomApi } from '../shared/api';
import { ErrorText } from './ErrorText';
import { useApi } from './api';

// What Settings and Projects build their pages from: a row per setting, each
// control saving its own changes and saying how that went.

/** One setting: its name and what it does on the left, its control on the right, or under them for a wide one. */
export function Setting({ title, description, wide, children }: { title: ReactNode; description?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'setting wide' : 'setting'}>
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {description && <div className="setting-description">{description}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** How long "Saved" shows after a change is saved. */
const SAVED_FOR_MS = 2000;

/**
 * Saving a setting's changes, and what to show of it: "Saved" for a moment
 * once main has kept one, or why main refused it, until the next change. Only
 * the latest change's outcome shows.
 */
export function useSaving() {
  const [outcome, setOutcome] = useState<{ saved?: boolean; error?: string }>({});
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  /** Shows how `sending` went; resolves with its result, or undefined once refused. */
  const save = useCallback(<T,>(sending: Promise<T>): Promise<T | undefined> => {
    const id = ++latest.current;
    clearTimeout(timer.current);
    setOutcome({});
    return sending.then(
      (result) => {
        if (id === latest.current) {
          setOutcome({ saved: true });
          timer.current = setTimeout(() => setOutcome({}), SAVED_FOR_MS);
        }
        return result;
      },
      (error: unknown) => {
        if (id === latest.current) setOutcome({ error: (error as Error).message });
        return undefined;
      },
    );
  }, []);
  /** Forgets how the last change went, as when the value is put back. */
  const clear = useCallback(() => {
    latest.current++;
    clearTimeout(timer.current);
    setOutcome({});
  }, []);
  /** Shows why a change can't be saved, without sending it. */
  const refuse = useCallback((error: string) => {
    latest.current++;
    clearTimeout(timer.current);
    setOutcome({ error });
  }, []);
  return { save, clear, refuse, ...outcome };
}

/** "Saved", announced, for a moment after a change is saved; why it was refused, if it was. */
export function SaveFeedback({ saved, error, errorId }: { saved?: boolean; error?: string; errorId?: string }) {
  return (
    <>
      <span className="saved" role="status">
        {saved && (
          <>
            <Check className="sm" />
            Saved
          </>
        )}
      </span>
      {error && (
        <div className="err" role="alert" id={errorId}>
          <ErrorText text={error} />
        </div>
      )}
    </>
  );
}

/**
 * One text setting, saved on Enter (Ctrl+Enter in a multi-line one) or on
 * leaving the field; Escape puts back the saved value. Says when it's saved,
 * or why it can't be (`check`, before sending) or why main refused it, until
 * the field holds a value that is taken, or the saved one again.
 */
export function TextSetting({
  label,
  stored,
  width,
  placeholder,
  multiline = false,
  inputMode,
  check,
  hint,
  save: send,
}: {
  label: string;
  /** The value main has kept. */
  stored: string;
  /** A narrow field's width; without it, the field takes the row's. */
  width?: string;
  placeholder?: string;
  multiline?: boolean;
  inputMode?: 'numeric';
  /** Why a value can't be saved, if it can't: it stays in the field, unsent, with why. */
  check?: (value: string) => string | undefined;
  /** What shows under the field while it has no error, from what it holds. */
  hint?: (value: string) => ReactNode;
  /** Sends the new value to main; resolves with the value as main kept it. */
  save: (api: LoomApi, value: string) => Promise<string>;
}) {
  const api = useApi();
  const [value, setValue] = useState(stored);
  const { save, clear, refuse, saved, error } = useSaving();
  const errorId = useId();
  useEffect(() => setValue(stored), [stored]);

  // Enter submits, then leaving the field blurs it: save each value once.
  const sent = useRef<string>(undefined);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (value === stored) {
      // Back to the saved value: a refusal of another no longer holds.
      if (error) clear();
      return;
    }
    if (value === sent.current) return;
    const invalid = check?.(value);
    if (invalid) return refuse(invalid);
    sent.current = value;
    void save(send(api, value))
      .then((kept) => kept !== undefined && setValue(kept))
      .finally(() => (sent.current = undefined));
  };
  const change = (next: string) => {
    setValue(next);
    // Once shown, why a value can't be saved follows the value, and goes when it is fixed.
    if (!error || !check) return;
    const invalid = next === stored ? undefined : check(next);
    if (invalid) refuse(invalid);
    else clear();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && (value !== stored || error)) {
      event.stopPropagation();
      setValue(stored);
      clear();
    } else if (multiline && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };
  const field = {
    className: 'tech text-setting',
    style: width ? { width } : undefined,
    'aria-label': label,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
    value,
    placeholder,
    spellCheck: false,
    onKeyDown,
    onBlur: () => submit(),
  };
  const shownHint = !error && hint?.(value);
  return (
    <form className="setting-form" onSubmit={submit}>
      {multiline ? (
        <textarea {...field} rows={3} onChange={(event) => change(event.target.value)} />
      ) : (
        <input {...field} inputMode={inputMode} onChange={(event) => change(event.target.value)} />
      )}
      {shownHint && <div className="muted setting-hint">{shownHint}</div>}
      <SaveFeedback saved={saved} error={error} errorId={errorId} />
    </form>
  );
}
