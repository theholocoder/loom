// Running a command to completion in an Environment, through its bridge's
// `exec` method.
import { BridgeRequestError } from './bridge-connection';

/** Sends one request to an Environment's bridge. */
export type BridgeCall = <T>(method: string, timeoutMs: number, params?: unknown) => Promise<T>;

export interface ExecResult {
  /** Where the command was found on the Environment's PATH. */
  path: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `command` with `args`, giving it `timeoutMs` and the bridge 5 s more
 * to answer. Rejects with a `not_found` BridgeRequestError (see isNotFound)
 * when the command isn't on the PATH.
 */
export function exec(call: BridgeCall, command: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return call<ExecResult>('exec', timeoutMs + 5_000, { command, args, timeoutMs });
}

/** Whether `error` says the command isn't on the Environment's PATH. */
export function isNotFound(error: unknown): boolean {
  return error instanceof BridgeRequestError && error.code === 'not_found';
}
