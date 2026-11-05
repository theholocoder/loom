// The usage dashboard: tokens, reported cost and outcomes across this
// machine's Sessions over 7, 30 or 90 days, as main computes them.
import { Coins, DatabaseZap, GitMerge, Inbox, MessagesSquare, Receipt, Timer, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { mergeRequestRef, USAGE_RANGES, type Project, type Session, type SessionOutcome, type TopSession, type UsageDashboard, type UsageRange } from '../shared/api';
import { useApi, useTopic } from './api';

/** Series colours, the prototype's categorical slots, in order. */
const SERIES = ['var(--p1)', 'var(--p2)', 'var(--p3)', 'var(--accent)', 'var(--wait)', 'var(--work)'];

const OUTCOME_LABEL: Record<SessionOutcome, string> = { merged: 'Merged', closed: 'Closed', archived: 'Archived', open: 'Open' };

export function Dashboard({ onOpenSession }: { onOpenSession: (session: Session) => void }) {
  const api = useApi();
  const projects = useTopic('projects') ?? [];
  const sessions = useTopic('sessions') ?? [];
  const [days, setDays] = useState<UsageRange>(7);
  const [data, setData] = useState<UsageDashboard>();
  const [error, setError] = useState<string>();
  // Worked out again whenever a Session's status changes, as runs end and Sessions are archived.
  const changed = sessions.reduce((latest, s) => Math.max(latest, s.updatedAt), 0);

  useEffect(() => {
    let current = true;
    setError(undefined);
    api.invoke('usage.dashboard', { days }).then(
      (value) => current && setData(value),
      (e: unknown) => current && setError((e as Error).message),
    );
    return () => {
      current = false;
    };
  }, [api, days, changed]);

  // Projects coloured by their place in the per-Project chart, the same in every chart.
  const colorOf = (projectId: number) => {
    const at = data?.perProject.findIndex((p) => p.projectId === projectId) ?? -1;
    return SERIES[(at < 0 ? 0 : at) % SERIES.length]!;
  };
  const shown = data?.days === days ? data : undefined;

  return (
    <main className="dash" aria-label="Dashboard">
      <div className="row">
        <h1>Dashboard</h1>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>
          Computed from Sessions on this machine
        </span>
      </div>
      <div className="dash-filters">
        <RangePicker days={days} onChange={setDays} />
      </div>
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      {shown && <Content data={shown} projects={projects} sessions={sessions} colorOf={colorOf} onOpenSession={onOpenSession} />}
    </main>
  );
}

function Content({
  data,
  projects,
  sessions,
  colorOf,
  onOpenSession,
}: {
  data: UsageDashboard;
  projects: Project[];
  sessions: Session[];
  colorOf: (projectId: number) => string;
  onOpenSession: (session: Session) => void;
}) {
  const { mix } = data;
  const mixParts = [
    { label: 'cache read', value: mix.cacheRead, color: 'var(--accent)' },
    { label: 'input', value: mix.input, color: 'color-mix(in srgb, var(--accent) 65%, var(--panel))' },
    { label: 'cache write', value: mix.cacheWrite, color: 'color-mix(in srgb, var(--accent) 45%, var(--panel))' },
    { label: 'output', value: mix.output, color: 'color-mix(in srgb, var(--accent) 30%, var(--panel))' },
    { label: 'reasoning', value: mix.reasoning, color: 'color-mix(in srgb, var(--accent) 18%, var(--panel))' },
  ];
  const outcomes = [
    { label: 'Merged', value: data.outcomes.merged, color: 'var(--ok)' },
    { label: 'Closed', value: data.outcomes.closed, color: 'var(--muted)' },
    { label: 'Archived, no Merge request', value: data.outcomes.archived, color: 'var(--muted)' },
    { label: 'Open', value: data.outcomes.open, color: 'var(--work)' },
    { label: 'Stuck at least once', value: data.outcomes.stuck, color: 'var(--err)' },
  ];
  return (
    <>
      <div className="tiles">
        <Tile icon={Coins} label="Tokens" value={formatTokens(data.tokens)} detail={`over the last ${data.days} days`} />
        <Tile icon={Receipt} label="Reported cost" value={`$${data.reportedCost.toFixed(2)}`} detail="As agents report it. Subscription and local models report $0." />
        <Tile icon={MessagesSquare} label="Sessions started" value={String(data.sessionsStarted)} detail={`${data.outcomes.stuck} stuck at least once`} />
        <Tile icon={GitMerge} label="Merge requests merged" value={String(data.mergeRequestsMerged)} detail={`${data.outcomes.open} Sessions still open`} />
        <Tile
          icon={DatabaseZap}
          label="Cache hit rate"
          value={data.cacheHitRate === undefined ? '—' : percent(data.cacheHitRate)}
          detail="Cache reads out of all prompt tokens"
        />
        <Tile icon={Timer} label="Median agent run" value={formatDuration(data.medianRunMs)} detail="Working → Waiting" />
        <Tile icon={Inbox} label="Median wait for you" value={formatDuration(data.medianWaitMs)} detail="On a question, an approval, or a finished run" />
      </div>
      <div className="cards">
        <section className="card wide" aria-labelledby="dash-per-day">
          <div className="card-head">
            <h3 id="dash-per-day">Tokens per day</h3>
            <div className="legend">
              {data.perProject.map(({ projectId, project }) => (
                <span key={projectId}>
                  <span className="sw" style={{ background: colorOf(projectId) }} />
                  {project}
                </span>
              ))}
            </div>
          </div>
          {data.tokens === 0 ? <div className="empty">No usage recorded in the last {data.days} days.</div> : <DayChart data={data} colorOf={colorOf} />}
        </section>
        <section className="card" aria-labelledby="dash-per-project">
          <div className="card-head">
            <h3 id="dash-per-project">Tokens per Project</h3>
          </div>
          <Bars label="Tokens per Project" rows={data.perProject.map((p) => ({ key: String(p.projectId), label: p.project, value: p.tokens, color: colorOf(p.projectId) }))} format={formatTokens} />
        </section>
        <section className="card" aria-labelledby="dash-per-model">
          <div className="card-head">
            <h3 id="dash-per-model">Tokens per model</h3>
          </div>
          <Bars label="Tokens per model" rows={data.perModel.map((m) => ({ label: m.model, value: m.tokens, color: 'var(--accent)', tech: true }))} format={formatTokens} />
        </section>
        <section className="card" aria-labelledby="dash-mix">
          <div className="card-head">
            <h3 id="dash-mix">Token mix</h3>
          </div>
          {data.tokens > 0 && (
            <div className="share" aria-hidden>
              {mixParts.map((part) => (part.value > 0 ? <div key={part.label} style={{ flex: part.value, background: part.color }} /> : null))}
            </div>
          )}
          <div className="legend wrap">
            {mixParts.map((part) => (
              <span key={part.label}>
                <span className="sw" style={{ background: part.color }} />
                {part.label} {percent(data.tokens ? part.value / data.tokens : 0)}
              </span>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
            Cache hit rate {data.cacheHitRate === undefined ? '—' : percent(data.cacheHitRate)}
          </p>
        </section>
        <section className="card" aria-labelledby="dash-outcomes">
          <div className="card-head">
            <h3 id="dash-outcomes">Session outcomes</h3>
            <span className="muted" style={{ fontSize: 12 }}>
              of Sessions started
            </span>
          </div>
          <Bars label="Session outcomes" rows={outcomes} format={String} />
        </section>
        <section className="card wide" aria-labelledby="dash-top">
          <div className="card-head">
            <h3 id="dash-top">Top Sessions by tokens</h3>
          </div>
          {data.topSessions.length === 0 ? (
            <div className="empty">No Sessions used tokens in the last {data.days} days.</div>
          ) : (
            <table className="data" aria-labelledby="dash-top">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Project</th>
                  <th>Issue / Merge request</th>
                  <th>Model</th>
                  <th className="n">Tokens</th>
                  <th className="n">Working time</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.topSessions.map((top) => {
                  const found = sessions.find((s) => s.id === top.sessionId);
                  return (
                    <tr
                      key={top.sessionId}
                      className={found ? 'click' : undefined}
                      tabIndex={found ? 0 : undefined}
                      title={found ? 'Open this Session' : undefined}
                      onClick={found ? () => onOpenSession(found) : undefined}
                      onKeyDown={found ? (e) => e.key === 'Enter' && onOpenSession(found) : undefined}
                    >
                      <td>{top.title}</td>
                      <td>{top.project}</td>
                      <td>{references(top, projects)}</td>
                      <td>
                        <span className="tech">{top.model}</span>
                      </td>
                      <td className="n">{formatTokens(top.tokens)}</td>
                      <td className="n">{formatDuration(top.workingMs)}</td>
                      <td>{OUTCOME_LABEL[top.outcome]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

/** 7, 30 or 90 days, as a radio group: one tab stop, arrows to move. */
function RangePicker({ days, onChange }: { days: UsageRange; onChange: (days: UsageRange) => void }) {
  const group = useRef<HTMLSpanElement>(null);
  const step = (by: number) => {
    const next = USAGE_RANGES[(USAGE_RANGES.indexOf(days) + by + USAGE_RANGES.length) % USAGE_RANGES.length]!;
    onChange(next);
    group.current?.querySelectorAll('button')[USAGE_RANGES.indexOf(next)]?.focus();
  };
  return (
    <span
      ref={group}
      className="seg"
      role="radiogroup"
      aria-label="Range"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        step(e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1);
      }}
    >
      {USAGE_RANGES.map((range) => (
        <button key={range} type="button" role="radio" aria-checked={range === days} tabIndex={range === days ? 0 : -1} className={range === days ? 'on' : ''} onClick={() => onChange(range)}>
          {range} days
        </button>
      ))}
    </span>
  );
}

function Tile({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  const id = `tile-${label.replaceAll(' ', '-').toLowerCase()}`;
  return (
    <div className="tile" role="group" aria-labelledby={id}>
      <div className="k" id={id}>
        <Icon className="sm" aria-hidden />
        {label}
      </div>
      <div className="v">{value}</div>
      <div className="d">{detail}</div>
    </div>
  );
}

function Bars({ label, rows, format }: { label: string; rows: Array<{ key?: string; label: string; value: number; color: string; tech?: boolean }>; format: (value: number) => string }) {
  if (!rows.length) return <div className="empty">Nothing yet.</div>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="hbars" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key ?? row.label} className="hbar">
          <span className={row.tech ? 'ellipsis tech' : 'ellipsis'} title={row.label}>
            {row.label}
          </span>
          <span className="track" aria-hidden>
            <span className="fill" style={{ width: `${(row.value / max) * 100}%`, background: row.color }} />
          </span>
          <span className="val">{format(row.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tokens per day as bars stacked by Project, with a tooltip per day. */
function DayChart({ data, colorOf }: { data: UsageDashboard; colorOf: (projectId: number) => string }) {
  const W = 820;
  const H = 230;
  const L = 46;
  const B = 24;
  const T = 8;
  const n = data.perDay.length;
  const bw = (W - L) / n;
  const barW = Math.max(2, bw * 0.68);
  const max = Math.max(...data.perDay.map((d) => d.tokens), 1) * 1.08;
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const base = H - B;
  const step = Math.ceil(n / 8);
  const order = data.perProject;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tokens per day by Project">
        {[0, 1, 2, 3].map((t) => {
          const v = (max / 3) * t;
          return (
            <g key={t}>
              <line className="grid" x1={L} x2={W} y1={y(v)} y2={y(v)} />
              <text x={L - 6} y={y(v) + 4} textAnchor="end">
                {formatTokens(v)}
              </text>
            </g>
          );
        })}
        {data.perDay.map((day, i) => {
          const x = L + i * bw + (bw - barW) / 2;
          let acc = 0;
          const segments = order
            .filter(({ projectId }) => (day.byProject[projectId] ?? 0) > 0)
            .map(({ projectId }) => {
              const v = day.byProject[projectId]!;
              const top = y(acc + v);
              const height = y(acc) - top;
              acc += v;
              return <rect key={projectId} x={x} y={top} width={barW} height={Math.max(0, height - 1)} rx={1.5} fill={colorOf(projectId)} />;
            });
          const labelled = i % step === (n - 1) % step;
          return (
            <g key={day.day}>
              {segments}
              {labelled && (
                <text x={x + barW / 2} y={H - 8} textAnchor="middle">
                  {shortDay(day.day)}
                </text>
              )}
              <rect className="hit" x={L + i * bw} y={T} width={bw} height={base - T}>
                <title>{`${shortDay(day.day)}: ${formatTokens(day.tokens)} tokens${order
                  .filter(({ projectId }) => day.byProject[projectId])
                  .map(({ projectId, project }) => `\n${project}: ${formatTokens(day.byProject[projectId]!)}`)
                  .join('')}`}</title>
              </rect>
            </g>
          );
        })}
        <line className="grid" x1={L} x2={W} y1={base} y2={base} />
      </svg>
    </div>
  );
}

/** The issue and Merge request a Top Session links to, as their Forge writes them. */
function references(top: TopSession, projects: Project[]): string {
  const kind = projects.find((p) => p.id === top.projectId)?.forge.kind;
  const refs = [top.issue && `#${top.issue.number}`, top.mergeRequest && mergeRequestRef(kind, top.mergeRequest.number)].filter(Boolean);
  return refs.length ? refs.join(' · ') : 'Session without issue';
}

/** A token count, short: 950, 12k, 1.2M, 3.4B. */
export function formatTokens(n: number): string {
  // Each unit from where its rounding would reach it: 999,600 is 1.0M, not 1000k.
  if (n >= 999.95e6) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 999.5e3) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 999.5) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** A duration, short: 30s, 6m 40s, 22m, 1h 12m; a dash for none. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** `2026-11-05` as `Nov 5`. */
function shortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}
