// PROTOTYPE (#256), throwaway: the tool-run variants on a fake conversation,
// in a plain browser (no Electron), for `pnpm prototype:tool-runs`.
// A second run plays live, a call every ~1.2 s, so the "doing now" state shows.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bot } from 'lucide-react';
import type { LoomApi, TranscriptItem } from '../shared/api';
import { ApiProvider } from './api';
import { ThinkingBlock } from './WorkCards';
import { PrototypeSwitcher, ToolRun, useVariant, withRuns } from './ToolRuns.prototype';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
type Said = Extract<TranscriptItem, { kind: 'agent' | 'thinking' }>;

const fakeApi = { subscribe: () => () => {}, invoke: async () => undefined, on: () => () => {} } as unknown as LoomApi;

let nextId = 1;
const tool = (name: string, toolKind: string, what: { subject?: string; command?: string }, status: Tool['status'] = 'completed', output = 'ok'): Tool => ({
  kind: 'tool',
  id: nextId++,
  toolCallId: `c${nextId}`,
  title: name,
  name,
  toolKind,
  ...what,
  status,
  input: JSON.stringify(what, null, 2),
  output,
});
const read = (p: string) => tool('read', 'read', { subject: p }, 'completed', `1\t# ${p}\n2\t…`);
const glob = (p: string) => tool('glob', 'search', { subject: p }, 'completed', 'a.yml\nb.yml');
const grep = (p: string) => tool('grep', 'search', { subject: p }, 'completed', 'src/ci/retention.ts:12: expire_in: 7 days');
const bash = (c: string, failed = false) => tool('bash', 'execute', { command: c }, failed ? 'failed' : 'completed', failed ? 'FAIL src/ci/retention.test.ts\n  ✕ expires after 30 days\n\nExpected: 30\nReceived: 7' : 'PASS src/ci/retention.test.ts\n  ✓ expires after 30 days');
const edit = (p: string): Tool => ({ ...tool('edit', 'edit', { subject: p }), diffs: [{ path: p, oldText: 'expire_in: 7 days\n', newText: 'expire_in: 30 days\n' }] });
const thinking = (text: string): Said => ({ kind: 'thinking', id: nextId++, text, streaming: false });
const agent = (text: string): Said => ({ kind: 'agent', id: nextId++, text, streaming: false });
const user = (text: string): TranscriptItem => ({ kind: 'user', id: nextId++, text });

const done: TranscriptItem[] = [
  user('Make CI artefacts expire after 30 days'),
  thinking('I need to find the CI config and the retention rules.'),
  read('.gitlab-ci.yml'),
  read('package.json'),
  glob('documentation/**'),
  grep('périmé|perime|obsolète|obsolete|archiv|supprim.*artefact|cleanup|retention'),
  thinking('Retention is set in two places; check the scripts.'),
  glob('scripts/**/*.sh'),
  read('scripts/cleanup.sh'),
  read('scripts/release.sh'),
  grep('expire_in'),
  bash('pnpm test --filter ci', true),
  read('src/ci/retention.ts'),
  edit('src/ci/retention.ts'),
  edit('.gitlab-ci.yml'),
  read('src/ci/retention.test.ts'),
  edit('src/ci/retention.test.ts'),
  bash('pnpm test --filter ci'),
  agent('Artefacts now expire after **30 days** in both `.gitlab-ci.yml` and the cleanup script, and the test covers it.'),
  user('Do the other pipelines too'),
  thinking('Checking the other pipelines too.'),
];

/** The live run's calls, played one by one: each shows running, then ends. */
const script: Array<Tool | Said> = [
  read('ci/deploy.yml'),
  glob('ci/**/*.yml'),
  read('ci/nightly.yml'),
  grep('expire_in'),
  thinking('nightly.yml keeps them for a week; change it.'),
  edit('ci/nightly.yml'),
  read('ci/review.yml'),
  edit('ci/review.yml'),
  bash('pnpm test --filter ci'),
  read('ci/release.yml'),
  grep('artifacts:expire'),
  agent('The nightly and review pipelines now keep artefacts for **30 days** too.'),
];

function useLive() {
  const [step, setStep] = useState(0); // 2 ticks per call: running, then done
  const [paused, setPaused] = useState(false);
  const end = script.length * 2;
  useEffect(() => {
    if (paused || step >= end) return;
    const t = setTimeout(() => setStep(step + 1), 1200);
    return () => clearTimeout(t);
  }, [step, paused, end]);
  const items: TranscriptItem[] = [];
  for (let i = 0; i < Math.ceil(step / 2) && i < script.length; i++) {
    const it = script[i]!;
    const running = step % 2 === 1 && i === Math.ceil(step / 2) - 1;
    items.push(it.kind === 'tool' ? { ...it, status: running ? 'running' : it.status, output: running ? undefined : it.output } : it);
  }
  return { items, working: step < end, paused, setPaused, restart: () => setStep(0) };
}

/** As Sessions' turnParts: the agent's words and thinking in a row under one name line. */
function turnParts(items: TranscriptItem[]): Array<Exclude<TranscriptItem, Said> | { said: Said[] }> {
  const parts: Array<Exclude<TranscriptItem, Said> | { said: Said[] }> = [];
  for (const item of items) {
    if (item.kind !== 'agent' && item.kind !== 'thinking') {
      parts.push(item);
      continue;
    }
    const last = parts.at(-1);
    const joins = last && 'said' in last && !(item.kind === 'thinking' && last.said.at(-1)!.kind === 'agent');
    if (joins) last.said.push(item);
    else parts.push({ said: [item] });
  }
  return parts;
}

const THEMES = ['paper', 'daylight', 'midnight', 'nord', 'mocha'];

function Demo() {
  const variant = useVariant();
  const live = useLive();
  const [theme, setTheme] = useState(() => new URLSearchParams(location.search).get('theme') ?? 'paper');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const u = new URL(location.href);
    u.searchParams.set('theme', theme);
    history.replaceState(history.state, '', u);
  }, [theme]);
  const parts = withRuns(turnParts([...done, ...live.items]), () => true);
  return (
    <div className="proto-demo">
      <div className="proto-demo-bar">
        <b>Tool runs · prototype #256</b>
        <span className="muted">Live run: {live.working ? (live.paused ? 'paused' : 'playing') : 'done'}</span>
        <button type="button" onClick={() => live.setPaused(!live.paused)} disabled={!live.working}>
          {live.paused ? 'Play' : 'Pause'}
        </button>
        <button type="button" onClick={live.restart}>
          Restart
        </button>
        <select value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Theme">
          {THEMES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="chat" role="log">
        {parts.map((item, at) =>
          'run' in item ? (
            <ToolRun key={`run-${item.run[0]!.id}`} variant={variant} run={item.run} live={live.working && at === parts.length - 1} />
          ) : 'said' in item ? (
            <div key={item.said[0]!.id} className="msg agent">
              <div className="who">
                <Bot />
              </div>
              <div className="body">
                <div className="name">OpenCode · Gemini 4 Neon</div>
                {item.said.map((s) =>
                  s.kind === 'thinking' ? (
                    <ThinkingBlock key={s.id} item={s} />
                  ) : (
                    <div key={s.id} className="bubble" dangerouslySetInnerHTML={{ __html: s.text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>') }} />
                  ),
                )}
              </div>
            </div>
          ) : item.kind === 'user' ? (
            <div key={item.id} className="msg user">
              <div className="body" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div className="bubble">{item.text}</div>
              </div>
            </div>
          ) : item.kind === 'tool' ? (
            <ToolRun key={item.id} variant="0" run={[item]} live={false} />
          ) : null,
        )}
      </div>
      <PrototypeSwitcher />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiProvider api={fakeApi}>
      <Demo />
    </ApiProvider>
  </StrictMode>,
);
