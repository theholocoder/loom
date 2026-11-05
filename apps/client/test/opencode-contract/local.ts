// The contract suites' Environment: this machine, with no bridge.
import { spawn } from 'node:child_process';
import type { AgentEnvironment } from '../../src/main/agents/adapter';
import type { Channel, ChannelParams } from '../../src/main/environments/channel';

/** Runs the agent on this machine, as the bridge's channel would in the native Environment. */
export const local: AgentEnvironment = {
  label: 'Native',
  openChannel: async ({ command, args = [], cwd, env }: ChannelParams) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    const channel = {
      listen: ({ onData, onExit }: Parameters<Channel['listen']>[0]) => {
        child.stdout.on('data', onData);
        child.on('exit', (code) => onExit({ exitCode: code ?? -1, stderr }));
      },
      write: async (data: string | Buffer) => void child.stdin.write(data),
      closeStdin: async () => void child.stdin.end(),
      kill: async () => void child.kill(),
    };
    return channel as unknown as Channel;
  },
};
