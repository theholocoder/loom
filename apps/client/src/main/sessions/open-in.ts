// Opening a Session's working copy, or a file in it, in the user's own editor
// or terminal: their command, run through the bridge in the Session's
// Environment with its full PATH.
import { isNotFound, type BridgeCall } from '../environments/exec';

/** How long the bridge may take to start the program. */
const LAUNCH_TIMEOUT_MS = 15_000;

/** Stands for the folder or file to open in an editor or terminal command. */
const PATH_PLACEHOLDER = '{path}';

export type Opener = 'editor' | 'terminal';

export interface OpenEnvironment {
  label: string;
  request: BridgeCall;
}

export interface OpenRequest {
  opener: Opener;
  /** The editor or terminal command setting. */
  command: string;
  /** The Session's working copy, where the program runs. */
  workingCopy: string;
  /** For the editor, a path relative to the working copy to open instead of it. */
  file?: string;
}

/**
 * Starts the user's editor or terminal in `environment`, and resolves once it
 * has started. The editor gets the path last unless its command says where
 * with `{path}`; the terminal only gets it where `{path}` says.
 */
export async function openIn(environment: OpenEnvironment, request: OpenRequest): Promise<void> {
  const words = splitCommandLine(request.command);
  if (!words.length) {
    throw new Error(request.opener === 'terminal' ? 'Set a terminal command in Settings to open a terminal.' : 'Set an editor command in Settings to open the editor.');
  }
  const path = request.file === undefined ? request.workingCopy : fileIn(request.workingCopy, request.file);
  const [program, ...rest] = words as [string, ...string[]];
  const args = rest.map((word) => word.replaceAll(PATH_PLACEHOLDER, path));
  if (request.opener === 'editor' && !words.some((word) => word.includes(PATH_PLACEHOLDER))) args.push(path);
  try {
    await environment.request('launch', LAUNCH_TIMEOUT_MS, { command: program, args, cwd: request.workingCopy });
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`${program} isn't installed in ${environment.label}, or isn't on your shell's PATH. Check the ${request.opener} command in Settings.`);
    }
    throw error;
  }
}

/**
 * Splits a command line into words as a shell would group them: "…" and '…'
 * quote, and backslashes are kept as they are, for Windows paths. Rejects an
 * unclosed quote.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | undefined;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote) throw new Error(`"${line}" has an unclosed quote`);
  if (inWord) words.push(word);
  return words;
}

/** `file`, relative to `workingCopy`, as a path there; rejects one that leads out of it. */
function fileIn(workingCopy: string, file: string): string {
  const parts = file.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
  if (/^([\\/]|[A-Za-z]:)/.test(file) || parts.includes('..') || !parts.length) {
    throw new Error(`"${file}" isn't in the Session's working copy`);
  }
  return `${workingCopy.replace(/[\\/]+$/, '')}/${parts.join('/')}`;
}
