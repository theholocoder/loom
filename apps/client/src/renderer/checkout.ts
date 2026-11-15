// What the agent offers in a Project's checkout, as main lists it (asking the
// agent once per checkout): its models, and its commands and skills.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentCommand, Commands, ModelChoice, Session } from '../shared/api';
import { useApi } from './api';
import type { Loaded } from './SearchPicker';

/** What main lists of a Project's checkout. */
type CheckoutListing = 'projects.models' | 'projects.commands';

/**
 * What main answers `listing` for the Project, asked again when `projectId`
 * or `generation` changes; nothing while `projectId` is undefined, or while
 * it is being asked.
 */
function useCheckoutListing<L extends CheckoutListing>(listing: L, projectId: number | undefined, generation = 0): Loaded<Commands[L]['result']> {
  const api = useApi();
  const [listed, setListed] = useState<{ projectId: number; result: NonNullable<Loaded<Commands[L]['result']>> }>();
  useEffect(() => {
    if (projectId === undefined) return;
    let current = true;
    // Both listings take the Project's id; TypeScript can't tell for a listing it only knows as one of them.
    (api.invoke(listing as 'projects.models', { id: projectId }) as Promise<Commands[L]['result']>)
      .then((value) => current && setListed({ projectId, result: { value } }))
      .catch((e: unknown) => current && setListed({ projectId, result: { error: (e as Error).message } }));
    return () => {
      current = false;
    };
  }, [api, listing, projectId, generation]);
  return listed && listed.projectId === projectId ? listed.result : undefined;
}

/**
 * The models the agent offers in the Project's checkout, asked again on
 * `refresh` after a failure; nothing while `projectId` is undefined.
 */
export function useCheckoutModels(projectId: number | undefined): { listed: Loaded<ModelChoice[]>; refresh: () => void } {
  const [generation, setGeneration] = useState(0);
  const listed = useCheckoutListing('projects.models', projectId, generation);
  // Listed, they stay so until the agent is checked again; only a failure is worth asking again.
  const failed = !!listed && 'error' in listed;
  const refresh = useCallback(() => failed && setGeneration((n) => n + 1), [failed]);
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
 * they can't be.
 */
export function useAgentCommands(projectId: number | undefined, announced?: AgentCommand[]): AgentCommand[] {
  const listed = useCheckoutListing('projects.commands', projectId);
  const checkout = listed && 'value' in listed ? listed.value : NO_COMMANDS;
  return useMemo(() => {
    const all = announced ? [...announced, ...checkout.filter((c) => c.kind === 'skill')] : checkout;
    const names = new Set<string>();
    return all.filter(({ name }) => !names.has(name) && !!names.add(name));
  }, [announced, checkout]);
}
