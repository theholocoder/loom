// The agent's commands and skills as Loom's, however it lists them: ACP's
// available commands, or OpenCode's own API through the bridge's probe.
import type { AgentCommand, SkillSource } from '../../shared/api';

const SOURCES: ReadonlySet<string> = new Set<SkillSource>(['project', 'personal', 'built-in']);

/**
 * The commands or skills in `list`, as Loom's: by name, with their
 * description and, for a skill the probe placed, where it comes from. Those
 * without a name are left out.
 */
export function agentCommandsOf(kind: AgentCommand['kind'], list: unknown): AgentCommand[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: { name?: unknown; description?: unknown; source?: unknown }) => {
    if (typeof item?.name !== 'string' || !item.name) return [];
    const description = typeof item.description === 'string' && item.description ? item.description : undefined;
    const source = typeof item.source === 'string' && SOURCES.has(item.source) ? (item.source as SkillSource) : undefined;
    return [{ kind, name: item.name, ...(description ? { description } : {}), ...(source ? { source } : {}) }];
  });
}
