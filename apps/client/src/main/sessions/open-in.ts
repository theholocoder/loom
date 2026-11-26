// Opening a Session's working copy, or a file in it, in the user's own editor
// or terminal: their command, run through the bridge in the Session's
// Environment with its full PATH.
import { splitCommandLine } from '../command-line';
import { isNotFound, type BridgeCall } from '../environments/exec';
import { windowsPath } from '../../shared/environment-paths';

/** How long the bridge may take to start the program. */
const LAUNCH_TIMEOUT_MS = 15_000;

/** Stands for the folder or file to open in an editor or terminal command. */
const PATH_PLACEHOLDER = '{path}';

export type Opener = 'editor' | 'terminal';

export interface OpenEnvironment {
  label: string;
  request: BridgeCall;
  /** For a WSL Environment: its distro, and the native Windows one, which runs Windows-only programs. */
  wsl?: { distro: string; windows: OpenEnvironment };
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
 * with `{path}`; the terminal only gets it where `{path}` says. In WSL, a
 * Windows-only program (one named as a Windows file, like `notepad.exe`) runs
 * natively and gets the path as Windows shows it, `\\wsl.localhost\<distro>\…`.
 */
export async function openIn(environment: OpenEnvironment, request: OpenRequest): Promise<void> {
  const [program, ...rest] = splitCommandLine(request.command);
  if (program === undefined) {
    throw new Error(request.opener === 'terminal' ? 'Set a terminal command in Settings to open a terminal.' : 'Set an editor command in Settings to open the editor.');
  }
  const { wsl } = environment;
  const onWindows = wsl && isWindowsProgram(program);
  const runIn = onWindows ? wsl.windows : environment;
  const command = onWindows && program.startsWith('/') ? windowsPath(wsl.distro, program) : program;
  const workingCopy = onWindows ? windowsPath(wsl.distro, request.workingCopy) : request.workingCopy;
  const path = request.file === undefined ? workingCopy : fileIn(workingCopy, request.file);
  // `{path}` is substituted only in the arguments, never in the program word, deliberately.
  const args = rest.map((word) => word.replaceAll(PATH_PLACEHOLDER, path));
  if (request.opener === 'editor' && !rest.some((word) => word.includes(PATH_PLACEHOLDER))) args.push(path);
  try {
    await runIn.request('launch', LAUNCH_TIMEOUT_MS, { command, args, ...(!onWindows && { cwd: workingCopy }) });
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`${program} isn't installed in ${runIn.label}, or isn't on your shell's PATH. Check the ${request.opener} command in Settings.`);
    }
    throw error;
  }
}

/** Whether `program` names a Windows file: one with a Windows program's extension, or a Windows path. */
function isWindowsProgram(program: string): boolean {
  return /\.(exe|cmd|bat|com)$/i.test(program) || /^([A-Za-z]:[\\/]|\\)/.test(program);
}

/** `file`, relative to `workingCopy`, as a path there; rejects one that leads out of it. */
function fileIn(workingCopy: string, file: string): string {
  const parts = file.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
  if (/^([\\/]|[A-Za-z]:)/.test(file) || parts.includes('..') || !parts.length) {
    throw new Error(`"${file}" isn't in the Session's working copy`);
  }
  // Written with the working copy's own separator, for Windows-only programs.
  const separator = workingCopy.includes('\\') && !workingCopy.includes('/') ? '\\' : '/';
  return `${workingCopy.replace(/[\\/]+$/, '')}${separator}${parts.join(separator)}`;
}
