// Loom's approval policy as OpenCode `permission` rules, passed to each
// `opencode acp` in OPENCODE_CONFIG_CONTENT, which carries nothing else.
//
// OpenCode (checked against 2.2.5 by the opt-in contract suite) keeps one
// ordered record per action: `shell` (also `bash`, its old name) matched
// against each simple command of a command line, `external_directory`
// against `<folder>/*` for anything outside the session's folder, and a
// tool's own name for the rest. `*` matches anything, `/` included; a
// trailing ` *` also matches no arguments; the last matching rule wins.
//
// The rules ask more widely than the policy, for whole command families
// (every `git push`, every `gh`), and Loom answers what its policy allows of
// them itself (see sessions/approvals.ts). Categories set to Allow add no
// rules; asks of theirs from the user's own OpenCode config are answered by
// Loom's settings too, Allow meaning the agent goes ahead.
import type { ApprovalPolicy } from '../../shared/api';
import { GLOBAL_FLAG_CLIS, SYSTEM_INSTALLS } from '../sessions/approvals';

export interface PermissionScope {
  policy: ApprovalPolicy;
  workingCopy: string;
  tempDir: string;
}

/** OpenCode's own tools, which the MCP and extension tools category leaves alone. */
export const OPENCODE_TOOLS = [
  'read',
  'edit',
  'write',
  'patch',
  'apply_patch',
  'glob',
  'grep',
  'list',
  'shell',
  'bash',
  'subagent',
  'task',
  'webfetch',
  'websearch',
  'codesearch',
  'todowrite',
  'todoread',
  'skill',
  'lsp',
  'question',
  'external_directory',
  'doom_loop',
];

/** The shell commands Loom's `system` category is about; they match what sessions/approvals.ts recognises. */
const SYSTEM_COMMANDS = [
  'sudo *',
  'doas *',
  ...GLOBAL_FLAG_CLIS.flatMap((cli) => ['-g', '--global'].flatMap((flag) => [`${cli} ${flag} *`, `${cli} * ${flag}`, `${cli} * ${flag} *`])),
  'yarn global *',
  'uv tool install *',
  ...['pip', 'pip3'].flatMap((cli) => [`${cli} install *--user*`, `${cli} install *--break-system-packages*`]),
  ...Object.entries(SYSTEM_INSTALLS).flatMap(([cli, subs]) => subs.map((sub) => `${cli} ${sub.startsWith('-') ? `${sub}*` : sub} *`)),
];

type Effect = 'ask' | 'allow' | 'deny';
export type OpenCodePermission = Record<string, Effect | Record<string, Effect>>;

/** The `permission` config for an agent working in `workingCopy` under `policy`. */
export function openCodePermission({ policy, workingCopy, tempDir }: PermissionScope): OpenCodePermission {
  const permission: OpenCodePermission = {};
  // First, so the rules after it win: every tool asks, then OpenCode's own are let through again.
  if (policy.mcp === 'ask') {
    permission['*'] = 'ask';
    for (const tool of OPENCODE_TOOLS) if (tool !== 'shell' && tool !== 'bash' && tool !== 'external_directory') permission[tool] = 'allow';
    // Loom's own tools only tell Loom something.
    permission['loom_*'] = 'allow';
  }
  const shell: Record<string, Effect> = policy.mcp === 'ask' ? { '*': 'allow' } : {};
  // Always: a push to the default branch asks whatever the settings say.
  shell['git push'] = 'ask';
  shell['git push *'] = 'ask';
  shell['git * push'] = 'ask';
  shell['git * push *'] = 'ask';
  if (policy.forge === 'ask' || policy.ownMergeRequest === 'ask') {
    shell['gh *'] = 'ask';
    shell['glab *'] = 'ask';
  }
  if (policy.system === 'ask') for (const pattern of SYSTEM_COMMANDS) shell[pattern] = 'ask';
  permission.shell = shell;
  if (policy.writeElsewhere === 'ask') {
    permission.external_directory = { '*': 'ask', [`${slashed(workingCopy)}/*`]: 'allow', [`${slashed(tempDir)}/*`]: 'allow' };
  } else if (policy.mcp === 'ask') {
    permission.external_directory = 'allow';
  }
  return permission;
}

/** The `permission` config for an agent with every tool refused: Session highlights' checks (ADR 0010). */
export const NO_TOOLS: OpenCodePermission = { '*': 'deny' };

/** A path with `/` only and no trailing one, as OpenCode's patterns want it. */
function slashed(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}
