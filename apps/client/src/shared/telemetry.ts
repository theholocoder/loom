// What main tells each renderer about reporting, on its command line
// (main/telemetry.ts): the preload reads it and hands it on to the renderer
// (renderer/telemetry.ts). There's no switch when main doesn't report.
import type { Machine } from './scrub';

export interface RendererTelemetry {
  tracesSampleRate: number;
  /** The machine's names, for the renderer to take out of what it sends, as main does. */
  machine: Machine;
}

const SWITCH = '--loom-telemetry=';

/** The renderer's command-line argument saying how to report. */
export function rendererTelemetryArgument(telemetry: RendererTelemetry): string {
  return `${SWITCH}${encodeURIComponent(JSON.stringify(telemetry))}`;
}

/** How the renderer reports, from its command line; undefined when it doesn't. */
export function rendererTelemetryOf(argv: readonly string[]): RendererTelemetry | undefined {
  const arg = argv.find((a) => a.startsWith(SWITCH));
  if (!arg) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(arg.slice(SWITCH.length))) as Partial<RendererTelemetry>;
    return { tracesSampleRate: Number(parsed.tracesSampleRate) || 0, machine: parsed.machine ?? {} };
  } catch {
    return undefined;
  }
}
