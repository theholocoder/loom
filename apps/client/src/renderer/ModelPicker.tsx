// The composer's model and Effort pickers and its context gauge, and the
// timeline marker of a change. Models show by the names their providers give
// them, with `provider/model`, as the agent names them, in a tooltip.
import { Brain, Cpu, Gauge } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_EFFORT, modelNameIn, type ContextUsage, type ModelChoice, type TranscriptItem } from '../shared/api';
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
  placeholder,
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
  /** What shows while no model is; by default, the agent's default model, named once the models listed say which. Given, there is no default to name, as for Session highlights, which need one picked. */
  placeholder?: string;
  disabled?: boolean;
  /** Called when the model list opens. */
  onOpen?: () => void;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
}) {
  const listed = listedModels(models);
  const agentDefault = placeholder === undefined ? defaultModelOf(listed) : undefined;
  return (
    <>
      <SearchPicker
        label="Model"
        placeholder={placeholder ?? (agentDefault ? `${modelName(listed, agentDefault.id)} (default)` : 'Default model')}
        tooltip={model !== undefined ? model : agentDefault ? `${agent}'s default model: ${agentDefault.id}` : undefined}
        tech={false}
        icon={<Cpu className="sm" />}
        noun="models"
        loading={`Asking ${agent} for its models…`}
        options={models && 'value' in models ? { value: models.value.map((m) => ({ key: m.id, label: modelName(listed, m.id), ...(m.name && m.name !== m.id && { detail: m.id }), value: m.id })) } : models}
        selected={model === undefined ? undefined : { key: model, label: modelName(listed, model) }}
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

/** The models listed; none while they aren't, or when they couldn't be. */
export function listedModels(listed: Loaded<ModelChoice[]>): ModelChoice[] | undefined {
  return listed && 'value' in listed ? listed.value : undefined;
}

/** The model `id` by the name its provider gives it, among `models`; its id when they don't name it. */
export function modelName(models: readonly ModelChoice[] | undefined, id: string): string {
  return modelNameIn(models, id) ?? id;
}

/** The model the agent runs without one picked, when `models` say which. */
export function defaultModelOf(models: readonly ModelChoice[] | undefined): ModelChoice | undefined {
  return models?.find((m) => m.default);
}

/** A model by `name`, `provider/model` in its tooltip; its id, as code, without a name. */
export function ModelName({ id, name }: { id: string; name: string | undefined }) {
  return (
    <span className={name ? undefined : 'tech'} title={id}>
      {name ?? id}
    </span>
  );
}

/** The Effort levels of `model` among the models listed; none while they aren't. */
export function effortsOf(listed: Loaded<ModelChoice[]>, model: string | undefined): string[] {
  return listedModels(listed)?.find((m) => m.id === model)?.efforts ?? [];
}

/** `effort` if the model takes it, or while the models aren't listed to say; else none, for the model's own default. */
export function effortTaken(listed: Loaded<ModelChoice[]>, model: string | undefined, effort: string | undefined): string | undefined {
  return effort !== undefined && (!listedModels(listed) || effortsOf(listed, model).includes(effort)) ? effort : undefined;
}

const tokens = new Intl.NumberFormat('en');

/** How much of its context window the agent has used, as a whole percentage. */
export function contextPercent(context: ContextUsage): number {
  return context.size > 0 ? Math.min(100, Math.round((context.used / context.size) * 100)) : 0;
}

/** How full the agent's context is, as a share of the model's window. */
export function ContextGauge({ context }: { context: ContextUsage }) {
  const percent = contextPercent(context);
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
export function ModelMarker({ item, models }: { item: Extract<TranscriptItem, { kind: 'model' }>; models: readonly ModelChoice[] | undefined }) {
  const parts = [
    item.model !== undefined && (
      <span key="model">
        Model <ModelName id={item.model} name={modelNameIn(models, item.model)} />
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
