// Opening a Session's working copy, or a file in it, in the user's own editor
// or terminal: their command, run through the bridge in the Session's
// Environment with its full PATH.
import { splitCommandLine } from '../command-line';
import { isNotFound, type BridgeCall } from '../environments/exec';
import { drivePathOf, onWindowsDrive, windowsPathOf } from '../../shared/environment-ids';

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
  const words = splitCommandLine(request.command);
  if (!words.length) {
    throw new Error(request.opener === 'terminal' ? 'Set a terminal command in Settings to open a terminal.' : 'Set an editor command in Settings to open the editor.');
  }
  const program = words[0]!;
  const { wsl } = environment;
  if (wsl && isWindowsProgram(program)) {
    const workingCopy = windowsPathOf(wsl.distro, request.workingCopy);
    return launch(wsl.windows, request.opener, onWindowsDrive(program) ? drivePathOf(program) : program, argsOf(request.opener, words, fileOf(workingCopy, request.file)));
  }
  return launch(environment, request.opener, program, argsOf(request.opener, words, fileOf(request.workingCopy, request.file)), request.workingCopy);
}

function argsOf(opener: Opener, [, ...rest]: string[], path: string): string[] {
  // `{path}` is substituted only in the arguments, never in the program word, deliberately.
  const args = rest.map((word) => word.replaceAll(PATH_PLACEHOLDER, path));
  if (opener === 'editor' && !rest.some((word) => word.includes(PATH_PLACEHOLDER))) args.push(path);
  return args;
}

function fileOf(workingCopy: string, file: string | undefined): string {
  return file === undefined ? workingCopy : fileIn(workingCopy, file);
}

/** Whether `program` names a Windows file: one with a Windows program's extension, or a Windows path. A distro's path to one is run as Windows writes it. */
function isWindowsProgram(program: string): boolean {
  return /\.(exe|cmd|bat|com)$/i.test(program) || /^([A-Za-z]:[\\/]|\\)/.test(program);
}

async function launch(environment: OpenEnvironment, opener: Opener, program: string, args: string[], cwd?: string): Promise<void> {
  try {
    await environment.request('launch', LAUNCH_TIMEOUT_MS, { command: program, args, ...(cwd !== undefined && { cwd }) });
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`${program} isn't installed in ${environment.label}, or isn't on your shell's PATH. Check the ${opener} command in Settings.`);
    }
    throw error;
  }
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
