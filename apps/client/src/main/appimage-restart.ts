import { spawn } from 'node:child_process';

export interface AppImageRestart {
  pid: number;
  appImage: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const closeDescriptorsInheritedFromElectron = 'for fd in /proc/$$/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done 2>/dev/null';
const waitForLoomToExit = 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done';
const startAppImage = 'exec "$@"';

const variablesOfTheOldAppImage = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'];

export function restartAppImage({ pid, appImage, args, env }: AppImageRestart): void {
  const script = [closeDescriptorsInheritedFromElectron, waitForLoomToExit, startAppImage].join('\n');
  const shell = spawn('bash', ['-c', script, String(pid), appImage, ...args], { detached: true, stdio: 'ignore', env: withoutVariablesOfTheOldAppImage(env) });
  shell.on('error', (error) => console.error('Loom could not start its update:', error.message));
  shell.unref();
}

function withoutVariablesOfTheOldAppImage(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !variablesOfTheOldAppImage.includes(name) && !name.startsWith('APPIMAGE_')));
}
