// "Restart to update" on Linux: the update replaces Loom's AppImage as Loom
// quits, then the new AppImage must start. Electron's app.relaunch can't start
// it: its relauncher sets no_new_privs, so the AppImage's setuid fusermount
// can't mount it and it exits at once. A plain detached shell, started from
// main, has no such limit.
import { spawn } from 'node:child_process';

export interface AppImageRestart {
  /** This Loom's process: the AppImage starts once it has exited, and released the single-instance lock. */
  pid: number;
  /** The updated AppImage. */
  appImage: string;
  /** This Loom's own arguments, to start the new one with. */
  args: string[];
  /** This Loom's environment. */
  env: NodeJS.ProcessEnv;
}

/**
 * Starts `appImage` with `args` once process `pid` has exited, from a shell
 * that outlives this one. The shell first closes the descriptors Electron
 * leaves open across exec (app.relaunch would have), which would otherwise
 * keep the old AppImage mounted and its profile files open in the new Loom.
 * Bash, which every AppImage's AppRun needs anyway: sh can't close fds past 9.
 */
export function restartAppImage({ pid, appImage, args, env }: AppImageRestart): void {
  const script = [
    'for fd in /proc/$$/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done 2>/dev/null',
    'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done',
    'exec "$@"',
  ].join('\n');
  const shell = spawn('bash', ['-c', script, String(pid), appImage, ...args], { detached: true, stdio: 'ignore', env: withoutAppImageVariables(env) });
  shell.on('error', (error) => console.error('Loom could not start its update:', error.message));
  shell.unref();
}

/** What the running AppImage's runtime set for its own mount, and electron-updater for its install. */
function withoutAppImageVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'].includes(name) && !name.startsWith('APPIMAGE_')));
}
