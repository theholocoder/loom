// Error reporting and feedback, to Loom's Sentry projects (issue #126): the
// errors Loom raises, its crashes, its warnings as logs, a sample of how long
// things take, and the feedback the user sends. Never what the user works
// on: no conversations, Projects, repositories, files, paths or people.
// Everything the SDK would gather on its own about the user, their requests
// or their variables is turned off, and every event, span, breadcrumb and log
// is scrubbed again on its way out (shared/scrub.ts).
//
// Release builds always report. Development, the tests and the self-test
// don't, unless LOOM_SENTRY=1 (LOOM_SENTRY=0 turns a release build's off).
import { homedir, hostname, userInfo } from 'node:os';
import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import type { Feedback, LoomApi } from '../shared/api';
import { scrubBreadcrumb, scrubEvent, scrubLog, scrubMessage, type Machine } from '../shared/scrub';
import { rendererTelemetryArgument } from '../shared/telemetry';

/** The `loom` project, which main, the preload and the renderer report to. Public by design: a DSN only lets one send. */
const CLIENT_DSN = 'https://2aaa8ae3b659d349a3c01855068c148f@o4512493613613056.ingest.de.sentry.io/4512493682884688';
/** The `loom-bridge` project, which the bridge reports to (bridge/report). */
const BRIDGE_DSN = 'https://25d24005fab079cf86c4e9ca086a4b1d@o4512493613613056.ingest.de.sentry.io/4512493682950224';

/** The default integrations Loom does without: they gather what the user did, said or had in memory. */
const DROPPED_INTEGRATIONS = new Set([
  // Console lines as breadcrumbs: they could say anything.
  'Console',
  // Local variables in stack frames: a prompt, a diff, a path.
  'LocalVariables',
  // Screenshots of the window: the conversation.
  'Screenshots',
  // Main's requests as breadcrumbs, with their URLs.
  'ElectronNet',
]);

export interface Telemetry {
  /** Arguments for each window's renderer, telling it whether and how to report. */
  rendererArguments: string[];
  /** Sends the user's feedback, with Loom's version and the system's details; absent when this build doesn't report. */
  sendFeedback?: (feedback: Feedback) => void;
  /** Logs what Loom's state says about its health: its bridge, its database, its updates. */
  watch(api: LoomApi): () => void;
}

function machine(): Machine {
  const names: Machine = { home: homedir() };
  try {
    names.user = userInfo().username;
  } catch {
    // No user name to take out where there's none.
  }
  names.host = hostname();
  return names;
}

function wanted(selfTesting: boolean): boolean {
  if (process.env.LOOM_SENTRY === '0') return false;
  if (process.env.LOOM_SENTRY === '1') return true;
  return app.isPackaged && !selfTesting;
}

/**
 * Starts reporting, as early as possible in main: before the app is ready,
 * so a crash at startup is reported too. Sets what the bridge needs to report
 * in main's own environment, which the bridge inherits.
 */
export function startTelemetry({ selfTesting }: { selfTesting: boolean }): Telemetry {
  if (!wanted(selfTesting)) return { rendererArguments: [], watch: () => () => {} };
  const names = machine();
  const release = `loom@${app.getVersion()}`;
  const environment = app.isPackaged ? 'production' : 'development';
  // Every trace while developing, so there's one to look at; a tenth in a release.
  const tracesSampleRate = app.isPackaged ? 0.1 : 1;
  Sentry.init({
    dsn: CLIENT_DSN,
    release,
    environment,
    tracesSampleRate,
    attachScreenshot: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    integrations: (defaults) => [
      ...defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
      Sentry.startupTracingIntegration(),
      // What Loom logs as an error is an error it raised and carried on from: each one is reported.
      Sentry.captureConsoleIntegration({ levels: ['error'] }),
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
    ],
    beforeSend: (event) => scrubEvent(event, names),
    beforeSendTransaction: (event) => scrubEvent(event, names),
    beforeSendSpan: (span) => scrubEvent(span, names),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb, names),
    beforeSendLog: (log) => scrubLog(log, names),
  });
  process.env.LOOM_BRIDGE_SENTRY_DSN = BRIDGE_DSN;
  process.env.LOOM_SENTRY_RELEASE = release;
  process.env.LOOM_SENTRY_ENVIRONMENT = environment;
  return {
    rendererArguments: [rendererTelemetryArgument({ tracesSampleRate, machine: names })],
    sendFeedback: ({ kind, message, email }) => {
      Sentry.captureFeedback({ message, email, source: 'loom-feedback-form' }, { captureContext: { tags: { feedback_kind: kind } } });
    },
    watch: (api) => watchHealth(api),
  };
}

/** Logs each change in the bridges', the database's and the updates' states: what went on before an error. */
function watchHealth(api: LoomApi): () => void {
  const stops: (() => void)[] = [];
  const environments = new Map<string, string>();
  stops.push(
    api.subscribe('update', (update) => {
      if (update.state === 'ready') Sentry.logger.info('update downloaded', { version: update.version });
    }),
  );
  let watchingEnvironments = false;
  stops.push(
    api.subscribe('database', (database) => {
      if (database.state === 'damaged') Sentry.logger.error('database damaged', { problem: database.problem });
      // The Environments are served once the database is open.
      if (database.state !== 'ok' || watchingEnvironments) return;
      watchingEnvironments = true;
      stops.push(
        api.subscribe('environments', (list) => {
          for (const environment of list) {
            if (environments.get(environment.id) === environment.state) continue;
            environments.set(environment.id, environment.state);
            const attributes = { environment: environment.id, state: environment.state, ...(environment.error ? { error: scrubMessage(environment.error) } : {}) };
            if (environment.state === 'failed' || environment.state === 'disconnected' || environment.state === 'unresponsive') Sentry.logger.warn(`bridge ${environment.state}`, attributes);
            else Sentry.logger.info(`bridge ${environment.state}`, attributes);
          }
        }),
      );
    }),
  );
  return () => {
    for (const stop of stops) stop();
  };
}
