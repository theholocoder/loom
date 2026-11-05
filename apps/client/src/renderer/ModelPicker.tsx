// The composer's model and Effort pickers and its context gauge, and the
// timeline marker of a change. Models show as `provider/model`, as the agent
// names them.
import { Brain, Cpu, Gauge } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_EFFORT, type ContextUsage, type ModelChoice, type TranscriptItem } from '../shared/api';
import { useApi } from './api';
import { Select } from './Popover';
import { SearchPicker, type Loaded } from './SearchPicker';

/** The model and Effort pickers: Effort only for a model that takes Effort levels. */
export function ModelPickers({
  agent,
  models,
  model,
  efforts,
  effort,
  disabled = false,
  onOpen,
  onModel,
  onEffort,
}: {
  /** The agent's name, as the UI shows it. */
  agent: string;
  /** What can be picked, once listed. */
  models: Loaded<ModelChoice[]>;
  /** The model shown, `provider/model`; the agent's default while absent. */
  model?: string;
  /** The shown model's Effort levels; none, no Effort picker. */
  efforts: string[];
  /** The Effort level shown; `default` while absent. */
  effort?: string;
  disabled?: boolean;
  /** Called when the model list opens. */
  onOpen?: () => void;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
}) {
  return (
    <>
      <SearchPicker
        label="Model"
        placeholder="Default model"
        icon={<Cpu className="sm" />}
        noun="models"
        loading={`Asking ${agent} for its models…`}
        options={models && 'value' in models ? { value: models.value.map((m) => ({ key: m.id, label: m.id, detail: m.name, value: m.id })) } : models}
        selected={model === undefined ? undefined : { key: model, label: model }}
        disabled={disabled}
        onOpen={onOpen}
        onChange={onModel}
      />
      {efforts.length > 0 && (
        <Select
          variant="compact"
          label="Effort"
          icon={<Brain className="sm" />}
          value={effort ?? DEFAULT_EFFORT}
          options={efforts.map((value) => ({ value, label: `Effort: ${value}` }))}
          disabled={disabled}
          onChange={onEffort}
        />
      )}
    </>
  );
}

/** The Effort levels of `model` among the models listed; none while they aren't. */
export function effortsOf(listed: Loaded<ModelChoice[]>, model: string | undefined): string[] {
  return (listed && 'value' in listed ? listed.value.find((m) => m.id === model)?.efforts : undefined) ?? [];
}

/**
 * The models the agent offers in the Project's checkout, listed by main when
 * `projectId` is given (main asks the agent once per checkout) and again on
 * `refresh` after a failure; nothing while `projectId` is undefined.
 */
export function useCheckoutModels(projectId: number | undefined): { listed: Loaded<ModelChoice[]>; refresh: () => void } {
  const api = useApi();
  const [listed, setListed] = useState<{ projectId: number; result: NonNullable<Loaded<ModelChoice[]>> }>();
  const [generation, setGeneration] = useState(0);
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
  const result = listed && listed.projectId === projectId ? listed.result : undefined;
  // Listed, they stay so until the agent is checked again; only a failure is worth asking again.
  const failed = !!result && 'error' in result;
  const refresh = useCallback(() => failed && setGeneration((n) => n + 1), [failed]);
  return { listed: result, refresh };
}

const tokens = new Intl.NumberFormat('en');

/** How full the agent's context is, as a share of the model's window. */
export function ContextGauge({ context }: { context: ContextUsage }) {
  const percent = Math.min(100, Math.round((context.used / context.size) * 100));
  return (
    <span
      className="gauge"
      role="meter"
      aria-label="Context"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      title={`${tokens.format(context.used)} of ${tokens.format(context.size)} tokens of context used`}
    >
      <Gauge className="sm" aria-hidden />
      {percent}%
    </span>
  );
}

/** Where the user changed the model or Effort, applying from the next prompt. */
export function ModelMarker({ item }: { item: Extract<TranscriptItem, { kind: 'model' }> }) {
  const parts = [
    item.model !== undefined && (
      <span key="model">
        Model <span className="tech">{item.model}</span>
      </span>
    ),
    item.effort !== undefined && (
      <span key="effort">
        Effort <span className="tech">{item.effort}</span>
      </span>
    ),
  ].filter(Boolean);
  return (
    <div className="interruption" role="note">
      <Cpu className="sm" />
      <span>
        {parts.flatMap((part, i) => (i ? [', ', part] : [part]))} from the next prompt
      </span>
    </div>
  );
}
