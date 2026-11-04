// Which approval category an agent's Approval request is in, from what the
// agent says it is about to do: the exact command, or the paths. The agent's
// own rules (see agents/opencode-permission.ts) ask more widely than Loom's
// policy, for whole command families such as every `git push`; this tells
// apart what Loom allows of them. A guardrail on a best-effort basis, not a
// security boundary: commands are read as words, not run or fully parsed.
import type { ApprovalCategory } from '../../shared/api';
import type { ApprovalAction } from '../agents/adapter';

/** What the classification needs to know of the Session. */
export interface ApprovalContext {
  /** The Session's working copy: its worktree, or the Project's checkout. */
  workingCopy: string;
  /** The Environment's temp directory. */
  tempDir: string;
  /** The user's home in the Environment, for `~`. */
  home?: string;
  /** The branch the working copy has checked out now; absent on a detached HEAD. */
  currentBranch?: string;
  /** The Project's default branch, as `origin/HEAD` names it, if known. */
  defaultBranch?: string;
  /** The number of the Session's own Merge request, once linked. */
  mergeRequest?: number;
}

/**
 * - `allowed`: Loom's policy lets it through whatever the settings say:
 *   reading files elsewhere, or a `gh`/`glab` command that changes nothing.
 * - otherwise, its category, absent when Loom can't tell (the user's own
 *   rules asked); `defaultBranch` names the default branch a push goes to,
 *   which always asks.
 */
export type ApprovalVerdict = { allowed: true } | { allowed?: false; category?: ApprovalCategory; defaultBranch?: string };

/** Whether a command may push: Loom then needs the branches to classify it. */
export function mayPush(action: ApprovalAction): boolean {
  return action.command !== undefined && /\bpush\b/.test(action.command);
}

/**
 * What an Approval request is about, part by part, most asking first: for a
 * command line, one verdict per simple command in a category (plain commands
 * such as `cd` don't count); for any other tool, one. The action may go
 * ahead only if every verdict lets it, so an allowed part never lets the
 * rest of the line through.
 */
export function classifyApproval(action: ApprovalAction, context: ApprovalContext): ApprovalVerdict[] {
  if (action.extension) return [{ category: 'mcp' }];
  if (action.command !== undefined) return classifyCommand(action.command, action.cwd ?? context.workingCopy, context);
  const outside = action.paths.some((path) => isOutside(path, context));
  if (!outside) return [{}];
  if (READ_KINDS.has(action.toolKind ?? '') || READ_TOOLS.has(action.tool)) return [{ allowed: true }];
  return [{ category: 'writeElsewhere' }];
}

const READ_KINDS = new Set(['read', 'search']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'list']);

/** The rank of each category among a command's parts: the one that asks most wins. */
const RANK: ApprovalCategory[] = ['system', 'otherPush', 'forge', 'writeElsewhere', 'mcp', 'ownMergeRequest', 'ownPush'];

/** A command line's categorised parts, most asking first (a push to the default branch first of all). */
function classifyCommand(command: string, cwd: string, context: ApprovalContext): ApprovalVerdict[] {
  const verdicts = commandsOf(command).map((words) => classifyWords(words, cwd, context));
  const rank = (v: ApprovalVerdict) => (v.allowed || !v.category ? RANK.length : RANK.indexOf(v.category) - (v.defaultBranch ? RANK.length : 0));
  const categorised = verdicts.filter((v) => !v.allowed && v.category).sort((a, b) => rank(a) - rank(b));
  if (categorised.length) return categorised;
  // Every part is one Loom lets through: a read-only Forge command.
  if (verdicts.length > 0 && verdicts.every((v) => v.allowed)) return [{ allowed: true }];
  return [{}];
}

const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup', 'nice', 'xargs']);

/** One simple command's verdict, from its words. */
function classifyWords(input: string[], cwd: string, context: ApprovalContext): ApprovalVerdict {
  let words = input;
  // Leading variable assignments and wrappers run the command after them.
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || WRAPPERS.has(words[0]!))) words = words.slice(1);
  const [program, ...args] = words;
  if (program === undefined) return {};
  const name = program.replace(/^.*[/\\]/, '');
  if (name === 'sudo' || name === 'doas' || isGlobalInstall(name, args)) return { category: 'system' };
  if (name === 'git') {
    const push = gitPush(args);
    if (push) return classifyPush(push, context);
  }
  if (name === 'gh' || name === 'glab') return classifyForge(name, args, context);
  if (words.some((word) => isOutside(pathOf(word, cwd, context.home), context))) return { category: 'writeElsewhere' };
  return {};
}

/** A word as a path, when it looks like one: absolute, from `~`, or out of `cwd` with `..`; redirections included. */
function pathOf(word: string, cwd: string, home: string | undefined): string {
  const bare = word.replace(/^(?:\d*[<>]+&?|--?[A-Za-z0-9-]+=)/, '');
  if (bare.startsWith('~') && home && (bare === '~' || bare[1] === '/')) return home + bare.slice(1);
  if (bare.startsWith('/') || /^[A-Za-z]:[/\\]/.test(bare)) return bare;
  if (bare === '..' || bare.startsWith('../')) return `${cwd}/${bare}`;
  return '';
}

/** Whether `path`, an absolute one, is neither in the working copy nor in the temp directory. */
function isOutside(path: string, { workingCopy, tempDir }: ApprovalContext): boolean {
  if (!path) return false;
  const normal = normalize(path);
  if (!normal.startsWith('/') && !/^[a-z]:\//i.test(normal)) return false;
  return ![workingCopy, tempDir].some((root) => within(normal, normalize(root)));
}

/** Whether `path` is `root` or under it, both normalized; case-insensitive for a Windows drive path. */
function within(path: string, root: string): boolean {
  if (!root) return false;
  const windows = /^[a-z]:\//i.test(root);
  const [p, r] = windows ? [path.toLowerCase(), root.toLowerCase()] : [path, root];
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** `\` as `/`, `.` and `..` resolved, no trailing `/`. */
function normalize(path: string): string {
  const parts: string[] = [];
  const slashed = path.replaceAll('\\', '/');
  const [first, ...rest] = slashed.split('/');
  for (const part of rest) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${first}/${parts.join('/')}`;
}

const GLOBAL_FLAGS = new Set(['-g', '--global']);
/** The package managers whose `-g`/`--global` installs for the whole machine. */
export const GLOBAL_FLAG_CLIS = ['npm', 'pnpm', 'bun', 'mise'];
/** Tools whose first argument (a subcommand, or a pacman flag's prefix) installs or removes for the whole machine. */
export const SYSTEM_INSTALLS: Record<string, string[]> = {
  cargo: ['install'],
  go: ['install'],
  gem: ['install'],
  pipx: ['install'],
  brew: ['install', 'reinstall', 'upgrade', 'uninstall'],
  apt: ['install', 'remove', 'purge'],
  'apt-get': ['install', 'remove', 'purge'],
  dnf: ['install', 'remove'],
  yum: ['install', 'remove'],
  pacman: ['-S', '-R'],
  zypper: ['install', 'remove'],
  snap: ['install', 'remove'],
  flatpak: ['install', 'uninstall'],
};

/** Installing for the whole machine or the user, rather than for the project. */
function isGlobalInstall(name: string, args: string[]): boolean {
  if (GLOBAL_FLAG_CLIS.includes(name) && args.some((a) => GLOBAL_FLAGS.has(a))) return true;
  if (name === 'yarn' && args[0] === 'global') return true;
  if (name === 'uv' && args[0] === 'tool' && args[1] === 'install') return true;
  if ((name === 'pip' || name === 'pip3') && args[0] === 'install' && args.some((a) => a === '--user' || a === '--break-system-packages')) return true;
  return SYSTEM_INSTALLS[name]?.some((sub) => args[0] === sub || (sub.startsWith('-') && args[0]?.startsWith(sub))) ?? false;
}

/** Git's options before its subcommand that take a value as the next word. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

interface Push {
  force: boolean;
  /** Deletes a remote branch or tag, pushes tags, or every branch. */
  wide: boolean;
  /** The refspecs given, if any. */
  refspecs: string[];
}

/** The push a `git` command line is, if it is one. */
function gitPush(args: string[]): Push | undefined {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += GIT_VALUE_OPTIONS.has(args[i]!) ? 2 : 1;
  if (args[i] !== 'push') return undefined;
  const push: Push = { force: false, wide: false, refspecs: [] };
  const positionals: string[] = [];
  for (let j = i + 1; j < args.length; j++) {
    const arg = args[j]!;
    if (arg === '--') {
      positionals.push(...args.slice(j + 1));
      break;
    }
    if (PUSH_VALUE_OPTIONS.has(arg)) {
      j++;
      continue;
    }
    if (arg.startsWith('--')) {
      const option = arg.split('=', 1)[0]!;
      if (option.startsWith('--force') || option === '--mirror') push.force = true;
      if (['--delete', '--all', '--branches', '--tags', '--mirror', '--prune', '--follow-tags'].includes(option)) push.wide = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const flags = arg.slice(1);
      if (flags.includes('f')) push.force = true;
      if (flags.includes('d')) push.wide = true;
      if (flags.includes('o')) j++;
      continue;
    }
    positionals.push(arg);
  }
  push.refspecs = positionals.slice(1);
  return push;
}

/** A push's verdict: to the default branch, the current branch plainly, or anything else. */
function classifyPush({ force, wide, refspecs }: Push, { currentBranch, defaultBranch }: ApprovalContext): ApprovalVerdict {
  const defaults = defaultBranch ? [defaultBranch] : ['main', 'master'];
  // With no refspec, git pushes the current branch (push.default `simple`).
  const targets = refspecs.length === 0 ? [currentBranch] : refspecs.map((refspec) => targetOf(refspec, currentBranch));
  const toDefault = targets.find((target) => target !== undefined && defaults.includes(target));
  if (toDefault) return { category: 'otherPush', defaultBranch: toDefault };
  if (force || wide || refspecs.some((r) => r.startsWith('+') || r.startsWith(':'))) return { category: 'otherPush' };
  if (currentBranch && targets.every((target) => target === currentBranch)) return { category: 'ownPush' };
  return { category: 'otherPush' };
}

/** The branch a refspec pushes to; undefined for a tag, or HEAD on a detached HEAD. */
function targetOf(refspec: string, currentBranch: string | undefined): string | undefined {
  const spec = refspec.replace(/^\+/, '');
  const [source, destination] = spec.includes(':') ? [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)] : [spec, spec];
  const target = destination || source;
  if (target.startsWith('refs/tags/')) return undefined;
  const branch = target.replace(/^refs\/heads\//, '');
  return branch === 'HEAD' || branch === '@' ? currentBranch : branch;
}

/** `gh`/`glab` commands that change nothing on the Forge, by command group. */
const READ_ONLY: Record<string, Set<string>> = {
  pr: new Set(['view', 'list', 'status', 'diff', 'checks', 'checkout']),
  mr: new Set(['view', 'list', 'diff', 'checkout']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view', 'list', 'clone']),
  run: new Set(['view', 'list', 'watch', 'download']),
  ci: new Set(['view', 'list', 'status', 'trace', 'get']),
  pipeline: new Set(['view', 'list', 'status', 'get']),
  release: new Set(['view', 'list', 'download']),
  workflow: new Set(['view', 'list']),
  label: new Set(['list']),
  auth: new Set(['status', 'token']),
  search: new Set(['issues', 'prs', 'repos', 'commits', 'code']),
  cache: new Set(['list']),
  variable: new Set(['list', 'get']),
};
const READ_ONLY_ALONE = new Set(['status', 'browse', 'help', 'version', '--version', '--help', 'completion']);

/** A `gh`/`glab` command's verdict: read-only, the Session's own Merge request, or another Forge change. */
function classifyForge(cli: 'gh' | 'glab', args: string[], { mergeRequest }: ApprovalContext): ApprovalVerdict {
  const [group, sub, ...rest] = args.filter((a, i) => !(a.startsWith('-') && i > 1) || a === '--help');
  if (group === undefined || READ_ONLY_ALONE.has(group) || (sub !== undefined && READ_ONLY[group]?.has(sub)) || sub === '--help') return { allowed: true };
  if (group === 'api') return apiWrites(args.slice(1)) ? { category: 'forge' } : { allowed: true };
  const own = cli === 'gh' ? group === 'pr' && ['create', 'edit', 'ready'].includes(sub ?? '') : group === 'mr' && ['create', 'update'].includes(sub ?? '');
  if (own) {
    const target = rest.find((word) => /^[#!]?\d+$/.test(word));
    if (sub === 'create' || target === undefined || Number(target.replace(/^[#!]/, '')) === mergeRequest) return { category: 'ownMergeRequest' };
  }
  return { category: 'forge' };
}

/** Whether `gh api`/`glab api` sends anything but a GET: a method, or fields (which make it a POST). */
function apiWrites(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const method = arg === '-X' || arg === '--method' ? args[i + 1] : /^(?:-X|--method=)(.+)$/.exec(arg)?.[1];
    if (method !== undefined) return method.toUpperCase() !== 'GET';
    if (/^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(arg) || /^-[fF]./.test(arg)) return true;
  }
  return false;
}

/**
 * The simple commands of a shell command line, as words: split at `;`,
 * `&&`, `||`, `|`, `&`, parentheses and newlines (so `$(...)` and subshells
 * are commands of their own), with quotes and backslashes taken off.
 */
export function commandsOf(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      word += line.slice(i + 1, end === -1 ? undefined : end);
      inWord = true;
      i = end === -1 ? line.length : end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && j + 1 < line.length) j++;
        word += line[j];
      }
      inWord = true;
      i = j;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')') {
      endCommand();
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}
