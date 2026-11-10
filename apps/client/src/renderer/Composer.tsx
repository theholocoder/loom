// The prompt box under a Session's conversation, and the New Session one:
// files and images attached to the message, comments on the diff going with
// it, @-mentions of the working copy's files, and `/` for the palette's actions.
import { ArrowUp, FileText, Image, ListPlus, MessageSquareCode, Paperclip, Square, SquareTerminal, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { diffCommentRange, isImage, type Attachment, type DiffComment, type NewAttachment } from '../shared/api';
import type { PaletteAction } from './CommandPalette';
import { stepIndex } from './Popover';
import { shortcutLabel } from './shortcuts';

/** The most files an @-mention suggests at once. */
const MAX_SUGGESTED = 50;

/**
 * The prompt box, with the agent's label and `tools` in its toolbar. Enter
 * sends, Shift+Enter adds a line. `onSend` resolves to whether to clear it.
 */
export function Composer({
  agent,
  placeholder,
  disabled = false,
  tools,
  focusRequest = 0,
  onSend,
  onDraftChange,
  canSendEmpty = false,
  canAttach = true,
  dock,
  clearKey,
  queueing = false,
  onStop,
  queue,
  gauge,
  loadFiles,
  commands = [],
  comments = [],
  onRemoveComment,
}: {
  /** The agent Sessions run on; a label, not a picker, in v1. */
  agent: string;
  placeholder: string;
  disabled?: boolean;
  tools?: ReactNode;
  /** Changing it focuses the prompt box. */
  focusRequest?: number;
  onSend: (prompt: string, attachments: NewAttachment[]) => Promise<boolean>;
  /** Called with the prompt as the user types it. */
  onDraftChange?: (draft: string) => void;
  /** Whether an empty prompt can be sent. */
  canSendEmpty?: boolean;
  /** Whether files can go with the message: not with an answer to a question. */
  canAttach?: boolean;
  /** What sits on the prompt box, part of it: the panel of a question it answers. */
  dock?: ReactNode;
  /** Changing it empties the prompt box: what was typed was for something else, such as another question. */
  clearKey?: string;
  /** Whether what is sent joins the queue, the agent working: the button says Queue. */
  queueing?: boolean;
  /** Given while the agent works: Stop interrupts its run. */
  onStop?: () => void;
  /** The Session's queue, shown above the prompt box. */
  queue?: ReactNode;
  /** How full the agent's context is, by the send button. */
  gauge?: ReactNode;
  /** Lists the working copy's files, for @-mentions; asked again each time one starts. */
  loadFiles?: () => Promise<string[]>;
  /** What `/` offers: the palette's actions. */
  commands?: PaletteAction[];
  /** The diff comments that go with what is sent, shown as chips; whoever gives them clears them once sent. */
  comments?: DiffComment[];
  onRemoveComment?: (index: number) => void;
}) {
  const id = useId();
  const [draft, setDraftState] = useState('');
  const [caret, setCaret] = useState(0);
  const setDraft = (value: string, at = value.length) => {
    setDraftState(value);
    setCaret(at);
    onDraftChange?.(value);
  };
  const prompt = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusRequest) prompt.current?.focus();
  }, [focusRequest]);
  const clearedFor = useRef(clearKey);
  useEffect(() => {
    if (clearedFor.current === clearKey) return;
    clearedFor.current = clearKey;
    setDraft('');
  }, [clearKey]);
  /** The files attached so far, each with a key of its own: the same file may be attached twice. */
  const [files, setFiles] = useState<Array<{ key: number; file: File }>>([]);
  const nextKey = useRef(0);
  const attachable = canAttach && !disabled;
  const attached = attachable ? files : [];
  const [sending, setSending] = useState(false);
  const canSend = !disabled && !sending && (canSendEmpty || draft.trim() !== '' || attached.length > 0 || comments.length > 0);
  const picker = useRef<HTMLInputElement>(null);
  const attach = (added: Iterable<File>) => {
    const list = [...added];
    if (list.length) setFiles((current) => [...current, ...list.map((file) => ({ key: nextKey.current++, file }))]);
  };

  const menu = useMenu({ draft, caret, commands, loadFiles });

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      const attachments = await Promise.all(attached.map(({ file }) => readAttachment(file)));
      if (await onSend(draft, attachments)) {
        setDraft('');
        setFiles([]);
      }
    } finally {
      setSending(false);
    }
  };
  /** Runs the menu's highlighted option: a command, or the file it mentions. */
  const pick = (index: number) => {
    const open = menu.open;
    if (!open) return;
    if (open.kind === 'command') {
      const command = open.options[index];
      if (!command) return;
      setDraft('');
      command.run(prompt.current);
      return;
    }
    const file = open.options[index];
    if (file === undefined) return;
    const mention = `@${file} `;
    const before = draft.slice(0, open.start) + mention;
    setDraft(before + draft.slice(caret).replace(/^\S*\s?/, ''), before.length);
    // The caret goes after the mention, once React has put the new text in.
    requestAnimationFrame(() => prompt.current?.setSelectionRange(before.length, before.length));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const open = menu.open;
    if (open && open.options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        menu.setActive(stepIndex(open.active + (event.key === 'ArrowDown' ? 1 : -1), open.options.length));
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        pick(open.active);
        return;
      }
    }
    if (open && event.key === 'Escape') {
      event.preventDefault();
      menu.dismiss();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) void send(event);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachable || !event.clipboardData.files.length) return;
    event.preventDefault();
    attach(event.clipboardData.files);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!attachable || !event.dataTransfer.files.length) return;
    event.preventDefault();
    attach(event.dataTransfer.files);
  };
  const listId = `${id}-menu`;
  const optionId = (index: number) => `${id}-option-${index}`;

  return (
    <form className="composer-wrap" aria-label="Composer" onSubmit={send}>
      {queue}
      <div className={`composer${dock ? ' docked' : ''}`} onDragOver={(event) => attachable && event.preventDefault()} onDrop={onDrop}>
        {dock}
        {menu.open && <MenuList id={listId} open={menu.open} optionId={optionId} onHover={menu.setActive} onPick={pick} />}
        {comments.length > 0 && (
          <ul className="attachments" aria-label="Diff comments">
            {comments.map((comment, index) => {
              const range = diffCommentRange(comment);
              return (
                <li key={`${index}:${range}`} className="chip" title={`${range}\n${comment.note}`}>
                  <MessageSquareCode className="sm" />
                  <span className="tech ellipsis">{range}</span>
                  {onRemoveComment && (
                    <button className="icon-btn sm" type="button" aria-label={`Remove comment on ${range}`} title="Remove" onClick={() => onRemoveComment(index)}>
                      <X className="sm" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {attached.length > 0 && (
          <ul className="attachments" aria-label="Attachments">
            {attached.map(({ key, file }) => (
              <AttachmentChip key={key} name={nameOf(file)} mimeType={file.type} size={file.size}>
                <button
                  className="icon-btn sm"
                  type="button"
                  aria-label={`Remove ${nameOf(file)}`}
                  title="Remove"
                  onClick={() => setFiles((current) => current.filter((f) => f.key !== key))}
                >
                  <X className="sm" />
                </button>
              </AttachmentChip>
            ))}
          </ul>
        )}
        <textarea
          ref={prompt}
          aria-label="Prompt"
          aria-controls={menu.open ? listId : undefined}
          aria-activedescendant={menu.open?.options.length ? optionId(menu.open.active) : undefined}
          rows={2}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={menu.dismiss}
        />
        <div className="ctoolbar">
          <span className="pick" title="Agent" style={{ cursor: 'default' }}>
            <SquareTerminal className="sm" />
            <b>{agent}</b>
          </span>
          {canAttach && (
            <>
              <button className="icon-btn" type="button" title="Attach files or images" aria-label="Attach" disabled={disabled} onClick={() => picker.current?.click()}>
                <Paperclip className="sm" />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                aria-label="Attach files or images"
                onChange={(event) => {
                  attach(event.target.files ?? []);
                  // The same file can be picked again.
                  event.target.value = '';
                }}
              />
            </>
          )}
          {tools}
          <span className="grow" />
          {gauge}
          {onStop && (
            <button className="send" type="button" onClick={onStop}>
              <Square />
              Stop
            </button>
          )}
          <button className="primary send" type="submit" disabled={!canSend}>
            {queueing ? <ListPlus /> : <ArrowUp />}
            {queueing ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
      <div className="hint">
        <span>
          <kbd>Enter</kbd> send
        </span>
        <span>
          <kbd>Shift Enter</kbd> newline
        </span>
        <span>
          <kbd>@</kbd> mention a file
        </span>
        {commands.length > 0 && (
          <span>
            <kbd>/</kbd> commands
          </span>
        )}
      </div>
    </form>
  );
}

/** What the menu over the prompt offers, while open: the actions `/` finds, or the files an @-mention finds. */
type OpenMenu =
  | { kind: 'command'; options: PaletteAction[]; active: number }
  | { kind: 'mention'; options: string[]; active: number; start: number; loading: boolean; error?: string };

/**
 * The menu over the prompt: `/` at the start of a one-line prompt lists the
 * actions matching what follows it; `@` after a space, or at the start, lists
 * the files matching what follows it up to the caret. Escape closes it until
 * what it was opened for changes.
 */
function useMenu({ draft, caret, commands, loadFiles }: { draft: string; caret: number; commands: PaletteAction[]; loadFiles?: () => Promise<string[]> }): {
  open: OpenMenu | undefined;
  setActive: (index: number) => void;
  dismiss: () => void;
} {
  const command = commands.length ? /^\/([^\n]*)$/.exec(draft) : null;
  const mention = !command && loadFiles ? /(^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret)) : null;
  /** Where the mention's `@` is. */
  const mentionStart = mention ? caret - mention[2]!.length - 1 : -1;
  /** What the menu is about: closing it closes it for that only. */
  const trigger = command ? 'command' : mention ? `mention:${mentionStart}` : undefined;
  const [dismissed, setDismissed] = useState<string>();
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<{ list?: string[]; loading: boolean; error?: string }>({ loading: false });
  // A new mention lists the files again: the agent may have added some.
  const mentionAt = mention ? trigger : undefined;
  useEffect(() => {
    if (!mentionAt || !loadFiles) return;
    let current = true;
    setFiles((was) => ({ ...was, loading: true }));
    loadFiles().then(
      (list) => current && setFiles({ list, loading: false }),
      (error: unknown) => current && setFiles((was) => ({ ...was, loading: false, error: (error as Error).message })),
    );
    return () => {
      current = false;
    };
  }, [mentionAt]);
  const query = (command?.[1] ?? mention?.[2] ?? '').toLowerCase();
  useEffect(() => setActive(0), [trigger, query]);
  useEffect(() => {
    if (dismissed !== undefined && dismissed !== trigger) setDismissed(undefined);
  }, [trigger]);

  let open: OpenMenu | undefined;
  if (trigger !== undefined && dismissed !== trigger) {
    if (command) {
      const words = query.split(/\s+/).filter(Boolean);
      const options = commands.filter((action) => words.every((word) => action.label.toLowerCase().includes(word)));
      open = { kind: 'command', options, active: stepIndex(active, options.length) };
    } else if (mention) {
      const options = matchFiles(files.list ?? [], query);
      open = { kind: 'mention', options, active: stepIndex(active, options.length), start: mentionStart, loading: files.loading && !files.list, ...(files.error ? { error: files.error } : {}) };
    }
  }
  return { open, setActive, dismiss: () => setDismissed(trigger) };
}

/**
 * The files matching `query`, best first: those whose name starts with it,
 * then whose name has it, then whose path does; the shorter name first, the
 * one closest to the exact name.
 */
function matchFiles(files: string[], query: string): string[] {
  if (!query) return files.slice(0, MAX_SUGGESTED);
  const rank = (path: string) => {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    if (name.startsWith(query)) return 0;
    if (name.includes(query)) return 1;
    return lower.includes(query) ? 2 : 3;
  };
  return files
    .map((path) => ({ path, rank: rank(path), name: path.length - path.lastIndexOf('/') }))
    .filter((f) => f.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.name - b.name || a.path.localeCompare(b.path))
    .slice(0, MAX_SUGGESTED)
    .map((f) => f.path);
}

function MenuList({ id, open, optionId, onHover, onPick }: { id: string; open: OpenMenu; optionId: (index: number) => string; onHover: (index: number) => void; onPick: (index: number) => void }) {
  useEffect(() => {
    document.getElementById(optionId(open.active))?.scrollIntoView?.({ block: 'nearest' });
  });
  const option = (index: number, label: string, children: ReactNode) => (
    <div
      key={index}
      id={optionId(index)}
      role="option"
      aria-label={label}
      aria-selected={index === open.active}
      onMouseMove={() => index !== open.active && onHover(index)}
      // Keep the focus in the prompt.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPick(index)}
    >
      {children}
    </div>
  );
  const empty = open.kind === 'mention' ? (open.error ?? (open.loading ? 'Listing files…' : 'No file matches.')) : 'No command matches.';
  return (
    <div id={id} className="composer-menu" role="listbox" aria-label={open.kind === 'command' ? 'Commands' : 'Files'}>
      {open.kind === 'command'
        ? open.options.map((action, index) =>
            option(
              index,
              action.label,
              <>
                <action.icon className="sm" />
                <span className="grow ellipsis">{action.label}</span>
                {action.shortcut && <kbd>{shortcutLabel(action.shortcut)}</kbd>}
              </>,
            ),
          )
        : open.options.map((path, index) =>
            option(
              index,
              path,
              <>
                <FileText className="sm" />
                <span className="tech ellipsis">{path}</span>
              </>,
            ),
          )}
      {open.options.length === 0 && <div className="muted composer-menu-empty">{empty}</div>}
    </div>
  );
}

/** The files and images sent with a message, in its bubble or its queued line. */
export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  return (
    <ul className="attachments" aria-label="Attachments">
      {attachments.map((attachment, index) => (
        <AttachmentChip key={`${index}:${attachment.hash}`} {...attachment}>
          <span className="muted">{sizeLabel(attachment.size)}</span>
        </AttachmentChip>
      ))}
    </ul>
  );
}

/** One attached file or image, by name, with what follows it: its size, or a Remove button. */
function AttachmentChip({ name, mimeType, size, children }: Pick<Attachment, 'name' | 'mimeType' | 'size'> & { children: ReactNode }) {
  return (
    <li className="chip" title={`${name} · ${sizeLabel(size)}`}>
      {isImage(mimeType) ? <Image className="sm" /> : <FileText className="sm" />}
      <span className="ellipsis">{name}</span>
      {children}
    </li>
  );
}

/** A file's name, as shown and sent: a pasted one may have none. */
function nameOf(file: File): string {
  return file.name || 'Pasted file';
}

async function readAttachment(file: File): Promise<NewAttachment> {
  const data = new Uint8Array(await file.arrayBuffer());
  return { name: nameOf(file), ...(file.type ? { mimeType: file.type } : {}), data };
}

/** A file's size, as people read it: `512 B`, `14 KB`, `2.3 MB`. */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
