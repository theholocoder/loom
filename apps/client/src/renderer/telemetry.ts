// The renderer's side of error reporting (main/telemetry.ts): its errors,
// what it logs as errors and warnings, and a sample of how long it takes to
// load. It reports through main, which scrubs everything again; it's only on
// when main says so, through the preload.
import * as Sentry from '@sentry/electron/renderer';
import { scrubBreadcrumb, scrubEvent, scrubLog } from '../shared/scrub';
import type { RendererTelemetry } from '../shared/telemetry';

declare global {
  interface Window {
    /** Set by the preload when this renderer reports errors. */
    loomTelemetry?: RendererTelemetry;
  }
}

/** The default integrations the renderer does without: clicks, console lines and requests as breadcrumbs, and the page's URL. */
const DROPPED_INTEGRATIONS = new Set(['Breadcrumbs', 'HttpContext']);

/** Starts reporting the renderer's errors, if main reports them. */
export function startTelemetry(): void {
  const options = window.loomTelemetry;
  if (!options) return;
  const { machine } = options;
  Sentry.init({
    tracesSampleRate: options.tracesSampleRate,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false },
    integrations: (defaults) => [
      ...defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
      // Page loads only: the renderer makes no requests of its own to trace.
      Sentry.browserTracingIntegration({ instrumentNavigation: false, traceFetch: false, traceXHR: false, enableInp: false, enableLongTask: false, enableLongAnimationFrame: false }),
      // What the renderer logs as an error is an error it raised and carried on from: each one is reported.
      Sentry.captureConsoleIntegration({ levels: ['error'] }),
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
    ],
    beforeSend: (event) => scrubEvent(event, machine),
    beforeSendSpan: (span) => scrubEvent(span, machine),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb, machine),
    beforeSendLog: (log) => scrubLog(log, machine),
  });
}
