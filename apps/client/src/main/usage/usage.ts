// The Usage service: writes usage buckets and the stretches of Session time
// the dashboard measures, and computes the dashboard from them and the
// Sessions' facts. Usage is kept indefinitely; nothing here deletes any.
import type { Kysely, Transaction } from 'kysely';
import { TOP_SESSIONS, totalTokens, USAGE_RANGES, type MergeRequestState, type SessionOutcome, type SessionStatus, type TokenCounts, type TopSession, type UsageDashboard, type UsageRange } from '../../shared/api';
import type { Schema, SessionSpansTable } from '../storage/schema';

/** One turn's usage, as the Session service records it. */
export interface TurnUsage {
  sessionId: number;
  projectId: number;
  projectName: string;
  /** The model Loom ran the turn with. */
  model: string;
  /** Clock time the turn ended: its day is the one it is filed under. */
  endedAt: number;
  tokens: TokenCounts;
  /** What the turn cost, in USD, as reported. */
  cost: number;
}

/** Adds a turn's usage to its Session × day × model bucket. */
export async function recordTurn(trx: Transaction<Schema>, turn: TurnUsage): Promise<void> {
  const { tokens, cost } = turn;
  await trx
    .insertInto('usage_buckets')
    .values({
      session_id: turn.sessionId,
      day: dayOf(turn.endedAt),
      model: turn.model,
      project_id: turn.projectId,
      project_name: turn.projectName,
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_tokens: tokens.cacheRead,
      cache_write_tokens: tokens.cacheWrite,
      reasoning_tokens: tokens.reasoning,
      cost,
    })
    .onConflict((oc) =>
      oc.columns(['session_id', 'day', 'model']).doUpdateSet((eb) => ({
        project_name: eb.ref('excluded.project_name'),
        input_tokens: eb('usage_buckets.input_tokens', '+', eb.ref('excluded.input_tokens')),
        output_tokens: eb('usage_buckets.output_tokens', '+', eb.ref('excluded.output_tokens')),
        cache_read_tokens: eb('usage_buckets.cache_read_tokens', '+', eb.ref('excluded.cache_read_tokens')),
        cache_write_tokens: eb('usage_buckets.cache_write_tokens', '+', eb.ref('excluded.cache_write_tokens')),
        reasoning_tokens: eb('usage_buckets.reasoning_tokens', '+', eb.ref('excluded.reasoning_tokens')),
        cost: eb('usage_buckets.cost', '+', eb.ref('excluded.cost')),
      })),
    )
    .execute();
}

/** Records a stretch of a Session's time: a run, or a wait for the user. */
export async function recordSpan(trx: Transaction<Schema>, span: SessionSpansTable): Promise<void> {
  if (span.ended_at <= span.started_at) return;
  await trx.insertInto('session_spans').values(span).execute();
}

/** What became of a Session, from its facts. */
export function outcomeOf({ status, mergeRequestState }: { status: SessionStatus; mergeRequestState: MergeRequestState | null }): SessionOutcome {
  if (mergeRequestState === 'merged' || mergeRequestState === 'closed') return mergeRequestState;
  if (status === 'archived' && mergeRequestState === null) return 'archived';
  return 'open';
}

/** The usage dashboard over the last `days` days up to `now`, today included. */
export async function dashboard(db: Kysely<Schema>, days: UsageRange, now: number): Promise<UsageDashboard> {
  if (!USAGE_RANGES.includes(days)) throw new Error(`The dashboard covers ${USAGE_RANGES.join(', ')} days, not ${String(days)}.`);
  const first = new Date(now);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - (days - 1));
  const since = first.getTime();
  const dayList = Array.from({ length: days }, (_, i) => {
    const day = new Date(first);
    day.setDate(first.getDate() + i);
    return dayOf(day.getTime());
  });
  const from = dayList[0]!;
  const to = dayList.at(-1)!;

  const [buckets, sessions, spans] = await Promise.all([
    db.selectFrom('usage_buckets').selectAll().where('day', '>=', from).where('day', '<=', to).execute(),
    db.selectFrom('sessions').selectAll().execute(),
    db.selectFrom('session_spans').selectAll().where('ended_at', '>=', since).where('ended_at', '<=', now).execute(),
  ]);

  const mix: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let reportedCost = 0;
  const perDay = new Map(dayList.map((day) => [day, { day, tokens: 0, byProject: {} as Record<number, number> }]));
  const perProject = new Map<number, number>();
  /** Each Project's name, as of the latest day its usage was recorded. */
  const projectNames = new Map<number, { name: string; day: string }>();
  const perModel = new Map<string, number>();
  const perSession = new Map<number, { tokens: number; projectId: number; byModel: Map<string, number> }>();
  for (const b of buckets) {
    const tokens = b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens + b.reasoning_tokens;
    mix.input += b.input_tokens;
    mix.output += b.output_tokens;
    mix.cacheRead += b.cache_read_tokens;
    mix.cacheWrite += b.cache_write_tokens;
    mix.reasoning += b.reasoning_tokens;
    reportedCost += b.cost;
    const day = perDay.get(b.day)!;
    day.tokens += tokens;
    day.byProject[b.project_id] = (day.byProject[b.project_id] ?? 0) + tokens;
    add(perProject, b.project_id, tokens);
    const named = projectNames.get(b.project_id);
    if (!named || named.day < b.day) projectNames.set(b.project_id, { name: b.project_name, day: b.day });
    add(perModel, b.model, tokens);
    let s = perSession.get(b.session_id);
    if (!s) perSession.set(b.session_id, (s = { tokens: 0, projectId: b.project_id, byModel: new Map() }));
    s.tokens += tokens;
    add(s.byModel, b.model, tokens);
  }

  const runs = spans.filter((s) => s.kind === 'run');
  const waits = spans.filter((s) => s.kind === 'wait');
  const workingMs = new Map<number, number>();
  for (const run of runs) add(workingMs, run.session_id, run.ended_at - run.started_at);

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const outcomeOfRow = (row: (typeof sessions)[number]) => outcomeOf({ status: row.status, mergeRequestState: row.merge_request_state });
  const started = sessions.filter((s) => s.created_at >= since && s.created_at <= now);
  const outcomes = { merged: 0, closed: 0, archived: 0, open: 0, stuck: 0 };
  for (const s of started) {
    outcomes[outcomeOfRow(s)]++;
    if (s.stuck_count > 0) outcomes.stuck++;
  }

  const topSessions: TopSession[] = [...perSession.entries()]
    .sort(([a, x], [b, y]) => y.tokens - x.tokens || a - b)
    .slice(0, TOP_SESSIONS)
    .map(([sessionId, usage]) => {
      const row = byId.get(sessionId);
      return withoutUndefined({
        sessionId,
        title: row?.title ?? `Session ${sessionId}`,
        projectId: usage.projectId,
        project: projectNames.get(usage.projectId)!.name,
        issue: row ? linkOf(row.issue_number, row.issue_url) : undefined,
        mergeRequest: row ? linkOf(row.merge_request_number, row.merge_request_url) : undefined,
        model: byTokens(usage.byModel)[0]!.key,
        tokens: usage.tokens,
        workingMs: workingMs.get(sessionId) ?? 0,
        outcome: row ? outcomeOfRow(row) : 'archived',
      });
    });

  const prompt = mix.input + mix.cacheRead + mix.cacheWrite;
  return withoutUndefined({
    days,
    perDay: [...perDay.values()],
    tokens: totalTokens(mix),
    reportedCost,
    sessionsStarted: started.length,
    mergeRequestsMerged: sessions.filter((s) => s.merge_request_state === 'merged' && s.archived_at !== null && s.archived_at >= since && s.archived_at <= now).length,
    medianRunMs: median(runs.map((s) => s.ended_at - s.started_at)),
    medianWaitMs: median(waits.map((s) => s.ended_at - s.started_at)),
    perProject: byTokens(perProject).map(({ key: projectId, tokens }) => ({ projectId, project: projectNames.get(projectId)!.name, tokens })),
    perModel: byTokens(perModel).map(({ key: model, tokens }) => ({ model, tokens })),
    mix,
    cacheHitRate: prompt > 0 ? mix.cacheRead / prompt : undefined,
    outcomes,
    topSessions,
  });
}

/** A clock time's day, `YYYY-MM-DD` in local time. */
export function dayOf(time: number): string {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function add<K>(map: Map<K, number>, key: K, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

/** Token counts by key, most first, then by key. */
function byTokens<K extends string | number>(map: Map<K, number>): Array<{ key: K; tokens: number }> {
  return [...map.entries()].sort(([a, x], [b, y]) => y - x || String(a).localeCompare(String(b))).map(([key, tokens]) => ({ key, tokens }));
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = ordered.length >> 1;
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1]! + ordered[mid]!) / 2;
}

function linkOf(number: number | null, url: string | null) {
  return number === null || url === null ? undefined : { number, url };
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
