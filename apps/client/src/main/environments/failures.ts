// Saying why git or a Forge CLI failed in a plain English sentence, with what
// it printed kept as the message's Details. The bridge runs them in the C
// locale (bridge/protocol/exec.go), so what they print is in English and the
// common messages can be recognised.
import { withDetails } from '../../shared/errors';
import type { ExecResult } from './exec';

/** What describeFailure says of a folder that isn't in a git repository. */
export const NOT_A_REPOSITORY = "it isn't in a git repository";

type Explainer = (output: string, cli: string) => string | undefined;

/** A sentence for each common failure, first match wins; each gets the whole output and the command run (`git`, `gh`, `glab`). */
const EXPLAINERS: Explainer[] = [
  // git: the repository and its refs.
  (out) => (/not a git repository/i.test(out) ? NOT_A_REPOSITORY : undefined),
  (out) => quoted(/detected dubious ownership in repository at '([^']+)'/.exec(out), (at) => `git won't work in ${at}, which another user owns, until you add it to its safe.directory`),
  (out) => quoted(/a branch named '([^']+)' already exists/.exec(out), (name) => `there's already a branch named "${name}"`),
  (out) => quoted(/'([^']+)' is already (?:checked out|used by worktree) at '([^']+)'/.exec(out), (name, at) => `"${name}" is already checked out in ${at}`),
  (out) => quoted(/'([^']+)' is not a valid branch name/.exec(out), (name) => `"${name}" isn't a valid branch name`),
  (out) =>
    quoted(
      /ambiguous argument '([^']+)': unknown revision/.exec(out) ?? /invalid reference: (\S+)/.exec(out) ?? /not a valid object name:? '?([^'\s]+)/i.exec(out) ?? /bad revision '([^']+)'/.exec(out),
      (name) => `there's no branch or commit "${name}"`,
    ),
  (out) => quoted(/fatal: '([^']+)' already exists/.exec(out), (path) => `there's already a folder at ${path}`),
  (out) => quoted(/Unable to create '([^']+\.lock)': File exists/.exec(out), (lock) => `another git command is running there, or one stopped and left ${lock} behind; wait for it, or delete that file`),
  (out) => (/contains modified or untracked files, use --force/.test(out) ? 'it has changes that would be lost' : undefined),
  (out) => (/would be overwritten by (?:checkout|merge)/.test(out) ? 'your local changes would be overwritten' : undefined),
  (out) => (/\bCONFLICT\b|Merge conflict|fix conflicts/.test(out) ? 'there are merge conflicts to resolve' : undefined),
  (out) => (/Please tell me who you are|unable to auto-detect email address/.test(out) ? "git doesn't know who you are: set your user.name and user.email" : undefined),
  (out) => (/nothing to commit/.test(out) ? "there's nothing to commit" : undefined),
  // Reaching a remote, for git and the Forge CLIs alike.
  (out) => quoted(/Could not resolve host(?:name)?:? '?([^\s':]+)/i.exec(out) ?? /dial tcp: lookup ([^\s:]+)/.exec(out), (host) => `couldn't reach ${host}: check your network connection`),
  (out) => (/Connection (?:timed out|refused)|Operation timed out|Network is unreachable|i\/o timeout|no route to host/i.test(out) ? "couldn't connect to the server: check your network connection" : undefined),
  (out) => (/Permission denied \(publickey/.test(out) ? 'the server refused your SSH key' : undefined),
  (out) => (/Host key verification failed/.test(out) ? "the server's SSH host key isn't one you have accepted" : undefined),
  (out) => (/Authentication failed|could not read Username|terminal prompts disabled/i.test(out) ? "the server didn't accept your credentials" : undefined),
  (out) => (/Repository not found|does not appear to be a git repository/i.test(out) ? "the repository wasn't found, or you don't have access to it" : undefined),
  // The Forge CLIs only: git would say these of other things (a hook's "command not found", say).
  (out, cli) => (cli !== 'git' && /\b401\b|not logged in|auth login|unauthorized|no token/i.test(out) ? `${cli} isn't signed in: run \`${cli} auth login\`` : undefined),
  (out, cli) => (cli !== 'git' && /rate limit/i.test(out) ? 'the Forge API rate limit is used up: try again in a while' : undefined),
  (out, cli) => (cli !== 'git' && /\b403\b|Forbidden/i.test(out) ? "you don't have permission to do that" : undefined),
  (out, cli) => (cli !== 'git' && /Could not resolve to a PullRequest/.test(out) ? "there's no such pull request" : undefined),
  (out, cli) => (cli !== 'git' && /Could not resolve to a Repository|\b404\b|Not Found/i.test(out) ? "it wasn't found, or you don't have access to it" : undefined),
];

function quoted(match: RegExpExecArray | null, say: (...parts: string[]) => string): string | undefined {
  return match ? say(...match.slice(1)) : undefined;
}

/** What tools put in front of their messages, which the sentence doesn't need. */
const PREFIX = /^(?:fatal|error|ERROR|gh|glab|GraphQL|remote)\s*:\s*/;

/**
 * Why `command` failed, as a plain sentence fragment (lower case, no full
 * stop, for after a colon), with what it printed as the Details. A message
 * Loom doesn't know is given as its first line.
 */
export function describeFailure(command: string, result: ExecResult): string {
  const output = (result.stderr || result.stdout).trim();
  if (!output) return `${command} exited with code ${result.exitCode}`;
  for (const explain of EXPLAINERS) {
    const said = explain(output, command);
    if (said) return withDetails(said, output);
  }
  const first = output.split('\n').find((line) => line.trim())!.trim();
  let said = first;
  while (PREFIX.test(said)) said = said.replace(PREFIX, '');
  said = said.replace(/\s*\(\w+\)$/, '').replace(/\.$/, '');
  return withDetails(said || first, output === said ? undefined : output);
}
