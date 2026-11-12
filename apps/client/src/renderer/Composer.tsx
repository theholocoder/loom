// The prompt box under a Session's conversation, and the New Session one:
// files and images attached to the message, comments on the diff going with
// it, @-mentions of the working copy's files, and `/` for the agent's skills
// and commands.
import { ArrowUp, Box, ClipboardPaste, Copy, FileText, FolderGit2, Image, ListPlus, MessageSquareCode, MessageSquareQuote, Paperclip, Scissors, Sparkles, Square, SquareSlash, SquareTerminal, User, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { diffCommentRange, isConversationComment, isImage, type AgentCommand, type Attachment, type MessageComment, type NewAttachment, type SkillSource } from '../shared/api';
import { addToContextMenu, copyText } from './ContextMenu';
import { useKeptState } from './drafts';
import { Popover, stepIndex } from './Popover';

/** The most files an @-mention suggests at once. */
const MAX_SUGGESTED = 50;

/**
 * The prompt box, with the agent's label and `tools` in its toolbar. Enter
 * sends, Shift+Enter adds a line. `onSend` resolves to whether to clear it.
 */
export function Composer({
  agent,
  placeholder,
  tips = false,
  disabled = false,
  tools,
  focusRequest = 0,
  onSend,
  onDraftChange,
  canSendEmpty = false,
  held = false,
  canAttach = true,
  dock,
  clearKey,
  queueing = false,
  onStop,
  queue,
  remarks,
  gauge,
  loadFiles,
  commands = [],
  comments = [],
  onRemoveComment,
  onEditComment,
  onEscape,
  onDisabledWithFocus,
  draftKey,
}: {
  /** The agent Sessions run on; a label, not a picker, in v1. */
  agent: string;
  placeholder: string;
  /** Whether the placeholder goes on to say what @ and / do: for a new message, not an answer. */
  tips?: boolean;
  disabled?: boolean;
  tools?: ReactNode;
  /** Changing it focuses the prompt box. */
  focusRequest?: number;
  onSend: (prompt: string, attachments: NewAttachment[]) => Promise<boolean>;
  /** Called with the prompt as the user types it. */
  onDraftChange?: (draft: string) => void;
  /** Whether an empty prompt can be sent. */
  canSendEmpty?: boolean;
  /** Whether sending waits for something outside the prompt box to be put right, such as a branch name; the prompt stays editable. */
  held?: boolean;
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
  /** What the controls under the prompt box have to say, such as why sending failed: shown just above it. */
  remarks?: ReactNode;
  /** How full the agent's context is, by the send button. */
  gauge?: ReactNode;
  /** Lists the working copy's files, for @-mentions; asked again each time one starts. */
  loadFiles?: () => Promise<string[]>;
  /** What `/` offers: the agent's skills and commands (see `useAgentCommands`). */
  commands?: AgentCommand[];
  /** The comments on the diff or the conversation that go with what is sent, shown as chips; whoever gives them clears them once sent. */
  comments?: MessageComment[];
  onRemoveComment?: (index: number) => void;
  /** Given, a click on a comment's chip edits its note. */
  onEditComment?: (index: number, note: string) => void;
  /** Given, Escape with no menu open runs it, to take the focus out of the prompt box. */
  onEscape?: () => void;
  /** The prompt box is being disabled with the focus in it, which it can't keep: where the focus goes instead. */
  onDisabledWithFocus?: () => void;
  /** Given, what is typed and attached is kept as its draft until sent, to be there again the next time a composer has it (see `useKeptState`). */
  draftKey?: string;
}) {
  const id = useId();
  const [draft, setDraftState] = useKeptState(draftKey, 'text', '');
  const [caret, setCaret] = useKeptState(draftKey, 'caret', 0);
  const setDraft = (value: string, at = value.length) => {
    setDraftState(value);
    setCaret(at);
  };
  // Also with a draft kept from before, which whoever listens hasn't seen.
  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft]);
  const prompt = useRef<HTMLTextAreaElement>(null);
  // A draft kept from before has its caret where it was left.
  useLayoutEffect(() => {
    prompt.current?.setSelectionRange(caret, caret);
  }, []);
  useEffect(() => {
    if (focusRequest) prompt.current?.focus();
  }, [focusRequest]);
  /** Whether the prompt box has the focus, or had it until it was disabled. */
  const focused = useRef(false);
  // Before the browser drops the focus of the disabled field to the page, where keys typed would run shortcuts.
  const handOnFocus = useRef(onDisabledWithFocus);
  handOnFocus.current = onDisabledWithFocus;
  useLayoutEffect(() => {
    if (!disabled || !(focused.current || document.activeElement === prompt.current)) return;
    focused.current = false;
    handOnFocus.current?.();
  }, [disabled]);
  // Kept with the draft: what it was typed for may have changed while away.
  const [clearedFor, setClearedFor] = useKeptState(draftKey, 'clearedFor', clearKey);
  useEffect(() => {
    if (clearedFor === clearKey) return;
    setClearedFor(clearKey);
    setDraft('');
  }, [clearKey]);
  /** The files attached so far, each with a key of its own: the same file may be attached twice. */
  const [files, setFiles] = useKeptState<Array<{ key: number; file: File }>>(draftKey, 'files', []);
  const nextKey = useRef(files.reduce((next, { key }) => Math.max(next, key + 1), 0));
  const attachable = canAttach && !disabled;
  const attached = attachable ? files : [];
  const [sending, setSending] = useState(false);
  const canSend = !disabled && !held && !sending && (canSendEmpty || draft.trim() !== '' || attached.length > 0 || comments.length > 0);
  const picker = useRef<HTMLInputElement>(null);
  const attach = (added: Iterable<File>) => {
    const list = [...added];
    if (list.length) setFiles((current) => [...current, ...list.map((file) => ({ key: nextKey.current++, file }))]);
  };

  const menu = useMenu({ draft, caret, commands, loadFiles });
  const fullPlaceholder = withTips(placeholder, {
    mentions: tips && !!loadFiles,
    commands: tips && commands.length > 0,
    diffComments: disabled ? 0 : comments.filter((c) => !isConversationComment(c)).length,
  });

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
  /** Puts the menu's highlighted option in the prompt: a skill or command, or the file it mentions. */
  const pick = (index: number) => {
    const open = menu.open;
    if (!open) return;
    if (open.kind === 'command') {
      const command = open.options[index];
      if (!command) return;
      setDraft(`/${command.name} `);
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
      // Enter on a skill or command typed in full sends it as it is.
      const typed = open.kind === 'command' && draft === `/${open.options[open.active]?.name}`;
      if ((event.key === 'Enter' && !event.shiftKey && !typed) || event.key === 'Tab') {
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
    // Left free for the view too: the same Esc leaves Review mode.
    if (onEscape && event.key === 'Escape') {
      onEscape();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) void send(event);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachable || !event.clipboardData.files.length) return;
    event.preventDefault();
    attach(event.clipboardData.files);
  };
  /** Puts `text` in place of the prompt's selection, the caret after it, as typing would. */
  const replaceSelection = (text: string) => {
    const box = prompt.current;
    if (!box) return;
    box.focus();
    // As typed: the browser's own undo then takes it back.
    if (typeof document.execCommand === 'function' && document.execCommand(text ? 'insertText' : 'delete', false, text)) return;
    const { selectionStart: start, selectionEnd: end } = box;
    const at = start + text.length;
    setDraft(draft.slice(0, start) + text + draft.slice(end), at);
    requestAnimationFrame(() => prompt.current?.setSelectionRange(at, at));
  };
  /** Paste from the menu: an image on the clipboard is attached, as Ctrl+V does; otherwise its text goes in. */
  const pasteFromClipboard = async () => {
    if (attachable) {
      const images = await clipboardImages().catch(() => []);
      if (images.length) {
        attach(images);
        return;
      }
    }
    const text = await navigator.clipboard.readText();
    if (text) replaceSelection(text);
  };
  /** Cut, Copy and Paste, on a right-click of the prompt. */
  const onContextMenu = (event: ReactMouseEvent<HTMLTextAreaElement>) => {
    const { selectionStart: start, selectionEnd: end } = event.currentTarget;
    const selected = draft.slice(start, end);
    addToContextMenu(event, [
      {
        label: 'Cut',
        icon: Scissors,
        disabled: disabled || !selected,
        run: () => {
          copyText(selected);
          replaceSelection('');
        },
      },
      { label: 'Copy', icon: Copy, disabled: !selected, run: () => copyText(selected) },
      {
        label: 'Paste',
        icon: ClipboardPaste,
        disabled,
        run: () => void pasteFromClipboard().catch((error: unknown) => console.error('could not paste:', error)),
      },
    ]);
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
      {remarks && <div className="composer-remarks">{remarks}</div>}
      <div className={`composer${dock ? ' docked' : ''}`} onDragOver={(event) => attachable && event.preventDefault()} onDrop={onDrop}>
        {dock}
        {menu.open && <MenuList id={listId} open={menu.open} optionId={optionId} onHover={menu.setActive} onPick={pick} />}
        {comments.length > 0 && (
          <ul className="attachments" aria-label="Comments">
            {comments.map((comment, index) => (
              <CommentChip
                key={`${index}:${commentTarget(comment)}`}
                comment={comment}
                onRemove={onRemoveComment && (() => onRemoveComment(index))}
                onEdit={onEditComment && ((note) => onEditComment(index, note))}
              />
            ))}
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
          placeholder={fullPlaceholder}
          disabled={disabled}
          value={draft}
          onChange={(event) => setDraft(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onContextMenu={onContextMenu}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={(event) => {
            // Disabled, it loses the focus: still counted as having it, to hand it on (see above).
            if (!event.currentTarget.disabled) focused.current = false;
            menu.dismiss();
          }}
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
    </form>
  );
}

/**
 * The placeholder, then what @ and / do, if they're to say, then how many
 * comments on the diff go with the message: "Reply to OpenCode… @ to mention
 * a file, / for commands. Your 1 diff comment goes with it."
 */
function withTips(placeholder: string, { mentions, commands, diffComments }: { mentions: boolean; commands: boolean; diffComments: number }): string {
  const keys = [mentions && '@ to mention a file', commands && '/ for commands'].filter(Boolean).join(', ');
  const comments = diffComments && `Your ${diffComments} diff ${diffComments === 1 ? 'comment goes' : 'comments go'} with it.`;
  return [placeholder, keys && (comments ? `${keys}.` : keys), comments].filter(Boolean).join(' ');
}

/** What the menu over the prompt offers, while open: the skills and commands `/` finds, or the files an @-mention finds. */
type OpenMenu =
  | { kind: 'command'; options: AgentCommand[]; active: number }
  | { kind: 'mention'; options: string[]; active: number; start: number; loading: boolean; error?: string };

/**
 * The menu over the prompt: `/` at the start of the prompt lists the skills
 * and commands matching what follows it, up to a space; `@` after a space, or at the start, lists
 * the files matching what follows it up to the caret. Escape closes it until
 * what it was opened for changes.
 */
function useMenu({ draft, caret, commands, loadFiles }: { draft: string; caret: number; commands: AgentCommand[]; loadFiles?: () => Promise<string[]> }): {
  open: OpenMenu | undefined;
  setActive: (index: number) => void;
  dismiss: () => void;
} {
  const command = commands.length ? /^\/(\S*)$/.exec(draft) : null;
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
      const options = matchCommands(commands, query);
      open = { kind: 'command', options, active: stepIndex(active, options.length) };
    } else if (mention) {
      const options = matchFiles(files.list ?? [], query);
      open = { kind: 'mention', options, active: stepIndex(active, options.length), start: mentionStart, loading: files.loading && !files.list, ...(files.error ? { error: files.error } : {}) };
    }
  }
  return { open, setActive, dismiss: () => setDismissed(trigger) };
}

/**
 * The skills and commands matching `query`, best first: the one named it,
 * those whose name starts with it, then whose name has it, then whose
 * description does; in the order given otherwise.
 */
function matchCommands(commands: AgentCommand[], query: string): AgentCommand[] {
  if (!query) return commands;
  const rank = ({ name, description }: AgentCommand) => {
    const lower = name.toLowerCase();
    if (lower === query) return 0;
    if (lower.startsWith(query)) return 1;
    if (lower.includes(query)) return 2;
    return description?.toLowerCase().includes(query) ? 3 : 4;
  };
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter((c) => c.rank < 4)
    .sort((a, b) => a.rank - b.rank)
    .map((c) => c.command);
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
  const empty = open.kind === 'mention' ? (open.error ?? (open.loading ? 'Listing files…' : 'No file matches.')) : 'Nothing matches.';
  return (
    <div id={id} className="composer-menu" role="listbox" aria-label={open.kind === 'command' ? 'Skills and commands' : 'Files'}>
      {open.kind === 'command'
        ? open.options.map((command, index) =>
            option(
              index,
              `/${command.name}`,
              <>
                {command.kind === 'skill' ? <Sparkles className="sm" aria-label="Skill" /> : <SquareSlash className="sm" aria-label="Command" />}
                <span className="cmd-name">
                  <span className="muted">/</span>
                  {command.name}
                </span>
                <span className="cmd-desc">{command.description}</span>
                {command.source && <SourceChip source={command.source} />}
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

/** What each skill source is called, and its icon. */
const SOURCES: Record<SkillSource, { label: string; icon: LucideIcon; title: string }> = {
  project: { label: 'Project', icon: FolderGit2, title: "In the Project's checkout" },
  personal: { label: 'Personal', icon: User, title: 'Your own, for every Project' },
  'built-in': { label: 'Built-in', icon: Box, title: "The agent's own" },
};

/** Where a skill comes from, at the end of its row. */
function SourceChip({ source }: { source: SkillSource }) {
  const { label, icon: Icon, title } = SOURCES[source];
  return (
    <span className="chip" title={title}>
      <Icon className="sm" aria-hidden />
      {label}
    </span>
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

/** The images on the clipboard, as files named as pasted: one per clipboard item, in its first image type. */
async function clipboardImages(): Promise<File[]> {
  if (typeof navigator.clipboard.read !== 'function') return [];
  const items = await navigator.clipboard.read();
  const images = items.flatMap((item) => {
    const type = item.types.find(isImage);
    return type ? [{ item, type }] : [];
  });
  return Promise.all(images.map(async ({ item, type }) => new File([await item.getType(type)], `Pasted image.${type.slice('image/'.length).split('+')[0]}`, { type })));
}

/** What a comment is on, as its chip names it: the range of the diff, or the passage quoted. */
function commentTarget(comment: MessageComment): string {
  return isConversationComment(comment) ? `“${quoteSummary(comment.quote)}”` : diffCommentRange(comment);
}

/** A comment going with the message: what it's on and its note, which a click edits. */
function CommentChip({ comment, onRemove, onEdit }: { comment: MessageComment; onRemove?: () => void; onEdit?: (note: string) => void }) {
  const [editing, setEditing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const quoted = isConversationComment(comment);
  const what = commentTarget(comment);
  const Icon = quoted ? MessageSquareQuote : MessageSquareCode;
  // On what shows it rather than the chip, so that it doesn't show over the form.
  const title = `${quoted ? comment.quote : what}\n\n${comment.note}`;
  const content = (
    <>
      <Icon className="sm" />
      <span className={`${quoted ? '' : 'tech '}what ellipsis`}>{what}</span>
      <span className="note ellipsis">{comment.note}</span>
    </>
  );
  return (
    <li className="chip comment-chip">
      {onEdit ? (
        <button ref={trigger} className="chip-edit" type="button" title={title} aria-label={`Edit comment on ${what}`} aria-haspopup="dialog" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {content}
        </button>
      ) : (
        <span className="chip-edit" title={title}>
          {content}
        </span>
      )}
      {onRemove && (
        <button className="icon-btn sm" type="button" aria-label={`Remove comment on ${what}`} title="Remove" onClick={onRemove}>
          <X className="sm" />
        </button>
      )}
      {editing && onEdit && (
        <CommentNoteForm
          anchor={trigger}
          label={`Edit comment on ${what}`}
          quote={quoted ? comment.quote : what}
          initial={comment.note}
          save="Save"
          onClose={() => setEditing(false)}
          onSave={(note) => {
            setEditing(false);
            onEdit(note);
            trigger.current?.focus();
          }}
        />
      )}
    </li>
  );
}

/**
 * The note on a comment, in a popover beside `anchor`, what it is on quoted
 * at its top: to add one, or to edit it. Ctrl+Enter saves it.
 */
export function CommentNoteForm({
  anchor,
  label,
  quote,
  initial = '',
  save = 'Add comment',
  onSave,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  /** What the comment is on: the passage of the conversation, or the range of the diff. */
  quote: string;
  initial?: string;
  /** The save button's label. */
  save?: string;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(initial);
  const done = () => note.trim() && onSave(note.trim());
  return (
    <Popover anchor={anchor} role="dialog" label={label} className="comment-note" onClose={onClose}>
      <blockquote className="muted ellipsis" title={quote}>
        {quoteSummary(quote)}
      </blockquote>
      <textarea
        data-autofocus
        aria-label="Comment"
        rows={3}
        placeholder="Note for the agent…"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            done();
          }
        }}
      />
      <div className="row">
        <span className="grow" />
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" type="button" disabled={!note.trim()} onClick={done}>
          {save}
        </button>
      </div>
    </Popover>
  );
}

/** How long a quote's chip lets it get. */
const QUOTE_CHIP_LENGTH = 40;

/** A quoted passage, as its chip says it: on one line, shortened. */
export function quoteSummary(quote: string): string {
  const line = quote.trim().replace(/\s+/g, ' ');
  return line.length > QUOTE_CHIP_LENGTH ? `${line.slice(0, QUOTE_CHIP_LENGTH - 1).trimEnd()}…` : line;
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
