// What the agent offers in a Project's checkout, as main lists it (asking the
// agent once per checkout, and its commands and skills again on `/`): its
// models, and its commands and skills.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentCommand, ModelChoice, Session } from '../shared/api';
import { useApi } from './api';
import type { Loaded } from './SearchPicker';

/**
 * The models main lists of the Project's checkout, asked again when
 * `projectId` or `generation` changes; nothing while `projectId` is
 * undefined, or while they are being asked.
 */
function useCheckoutModelListing(projectId: number | undefined, generation: number): Loaded<ModelChoice[]> {
  const api = useApi();
  const [listed, setListed] = useState<{ projectId: number; result: NonNullable<Loaded<ModelChoice[]>> }>();
  useEffect(() => {
    if (projectId === undefined) return;
    let current = true;
    api
      .invoke('projects.models', { id: projectId })
      .then((value) => current && setListed({ projectId, result: { value } }))
      .catch((e: unknown) => current && setListed({ projectId, result: { error: (e as Error).message } }));
    return () => {
      current = false;
    };
  }, [api, projectId, generation]);
  return listed && listed.projectId === projectId ? listed.result : undefined;
}

/**
 * The models the agent offers in the Project's checkout, asked again on
 * `refresh` after a failure or when it listed none; nothing while `projectId`
 * is undefined.
 */
export function useCheckoutModels(projectId: number | undefined): { listed: Loaded<ModelChoice[]>; refresh: () => void } {
  const [generation, setGeneration] = useState(0);
  const listed = useCheckoutModelListing(projectId, generation);
  // Listed, they stay so until the agent is checked again; only a failure, or none listed (the agent may not have loaded them yet), is worth asking again.
  const askAgain = !!listed && ('error' in listed || listed.value.length === 0);
  const refresh = useCallback(() => askAgain && setGeneration((n) => n + 1), [askAgain]);
  return { listed, refresh };
}

/**
 * The models a Session's agent offers, as it last said; until it has (it
 * hasn't run since the Client started), those of its Project's checkout,
 * asked again on `refresh` after a failure.
 */
export function useSessionModels(session: Pick<Session, 'agentConfig'>, projectId: number | undefined): { listed: Loaded<ModelChoice[]>; refresh: () => void } {
  const { agentConfig } = session;
  const checkout = useCheckoutModels(agentConfig ? undefined : projectId);
  const offered = agentConfig?.models;
  const listed = useMemo(() => (offered ? { value: offered } : checkout.listed), [offered, checkout.listed]);
  return { listed, refresh: checkout.refresh };
}

/** No skills or commands, the same each time. */
const NO_COMMANDS: AgentCommand[] = [];

/**
 * The skills and commands `/` offers: the agent's in the Project's checkout,
 * with `announced`, the commands a Session's agent announced, in place of the
 * checkout's commands when given; each name once, a command before a skill of
 * the same name, as the agent runs it. None while they aren't listed, or when
 * they can't be. `refresh` asks the agent for them again, as the user may
 * have added a skill since; what was listed stays until it answers, and if it
 * can't.
 */
export function useAgentCommands(projectId: number | undefined, announced?: AgentCommand[]): { commands: AgentCommand[]; refresh: () => void } {
  const api = useApi();
  const [listed, setListed] = useState<{ projectId: number; commands: AgentCommand[] }>();
  /** How many times the commands were asked for again. */
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (projectId === undefined) return;
    let current = true;
    api
      .invoke('projects.commands', generation ? { id: projectId, fresh: true } : { id: projectId })
      .then((commands) => current && setListed({ projectId, commands }))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [api, projectId, generation]);
  const checkout = listed && listed.projectId === projectId ? listed.commands : NO_COMMANDS;
  const commands = useMemo(() => {
    const all = announced ? [...announced, ...checkout.filter((c) => c.kind === 'skill')] : checkout;
    const names = new Set<string>();
    return all.filter(({ name }) => !names.has(name) && !!names.add(name));
  }, [announced, checkout]);
  const refresh = useCallback(() => setGeneration((n) => n + 1), []);
  return { commands, refresh };
}
