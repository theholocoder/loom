import { CircleCheckBig, CircleX, CodeXml, FolderTree, GitPullRequestArrow, LoaderCircle, Palette, RotateCw, Server, ShieldAlert, Timer, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { APPROVAL_CATEGORIES, MAX_AUTO_PROMPTS, OPENCODE_MIN_VERSION, type AgentStatus, type ApprovalCategory, type ApprovalSetting, type EnvironmentState, type EnvironmentStatus, type LoomApi } from '../shared/api';
import { MONO_FONTS, THEMES, UI_FONTS, type Appearance } from '../shared/appearance';
import { useApi, useTopic } from './api';
import { Select } from './Popover';
import { ErrorAlert } from './Questions';

// The prototype has no Settings page; it uses the layout of its other full
// page, the Dashboard: a .dash page with a card holding a data table.
export function Settings() {
  const api = useApi();
  const environments = useTopic('environments') ?? [];
  // Opening Settings checks the agents again, so what it shows is current.
  useEffect(() => {
    api.invoke('environments.detect').catch((error: unknown) => console.error('agent detection failed:', error));
  }, [api]);
  return (
    <main className="dash" aria-label="Settings">
      <div className="row">
        <h1>Settings</h1>
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <Palette className="sm" />
          <h3>Appearance</h3>
        </div>
        <AppearancePickers />
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
            <Server className="sm" />
            <h3>Environments</h3>
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>Environment</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Bridge</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {environments.map((env) => (
                <EnvironmentRow key={env.id} env={env} />
              ))}
            </tbody>
          </table>
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <ShieldAlert className="sm" />
          <h3>Approvals</h3>
        </div>
        <ApprovalSettings />
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <Timer className="sm" />
          <h3>Stuck Sessions</h3>
        </div>
        <StuckAfter />
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <GitPullRequestArrow className="sm" />
          <h3>Merge request feedback</h3>
        </div>
        <AutoPromptDefault />
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <FolderTree className="sm" />
          <h3>Worktrees</h3>
        </div>
        <WorktreeRoot />
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <CodeXml className="sm" />
          <h3>Editor and terminal</h3>
        </div>
        <OpenCommands />
      </div>
    </main>
  );
}

const THEME_OPTIONS = (Object.keys(THEMES) as Appearance['theme'][]).map((value) => ({ value, label: THEMES[value].label }));
const UI_FONT_OPTIONS = (Object.keys(UI_FONTS) as Appearance['uiFont'][]).map((value) => ({ value, label: value }));
const MONO_FONT_OPTIONS = (Object.keys(MONO_FONTS) as Appearance['monoFont'][]).map((value) => ({ value, label: value }));

/** The theme and fonts, which the window takes on as soon as they're saved. */
function AppearancePickers() {
  const api = useApi();
  const settings = useTopic('settings');
  const [error, setError] = useState<string>();
  if (!settings) return null;
  const save = (change: Partial<Appearance>) => {
    setError(undefined);
    api.invoke('settings.setAppearance', change).catch((e: unknown) => setError((e as Error).message));
  };
  return (
    <div className="settings-fields">
      <div className="field-row">
        <span>Theme</span>
        <Select label="Theme" value={settings.theme} options={THEME_OPTIONS} onChange={(theme) => save({ theme })} />
      </div>
      <div className="field-row">
        <span>UI font</span>
        <Select label="UI font" value={settings.uiFont} options={UI_FONT_OPTIONS} onChange={(uiFont) => save({ uiFont })} />
      </div>
      <div className="field-row">
        <span>Monospace font</span>
        <Select label="Monospace font" className="tech" value={settings.monoFont} options={MONO_FONT_OPTIONS} onChange={(monoFont) => save({ monoFont })} />
      </div>
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

const APPROVAL_OPTIONS: { value: ApprovalSetting; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
];

/** Whether the agent asks before each category of action beyond its working copy. */
function ApprovalSettings() {
  const api = useApi();
  const approvals = useTopic('settings')?.approvals;
  const [error, setError] = useState<string>();
  if (!approvals) return null;
  const save = (category: ApprovalCategory, setting: ApprovalSetting) => {
    setError(undefined);
    api.invoke('settings.setApproval', { category, setting }).catch((e: unknown) => setError((e as Error).message));
  };
  return (
    <div className="settings-fields">
      <p className="muted" style={{ margin: 0 }}>
        The agent reads, edits and runs commands in its working copy and the temp directory freely. For the rest, Ask pauses it with an Approval request. Rules match commands and paths on a best-effort basis: a guardrail, not a security boundary. Agents started from now on get the changes.
      </p>
      {(Object.keys(APPROVAL_CATEGORIES) as ApprovalCategory[]).map((category) => (
        <div key={category} className="field-row approval-row">
          <span>
            {APPROVAL_CATEGORIES[category].label}
            <span className="muted approval-description">{APPROVAL_CATEGORIES[category].description}</span>
          </span>
          <Select label={APPROVAL_CATEGORIES[category].label} value={approvals[category]} options={APPROVAL_OPTIONS} onChange={(setting) => save(category, setting)} />
        </div>
      ))}
      <ErrorAlert error={error} />
    </div>
  );
}

/** How long a Working Session's agent may say nothing before the Session is stuck. */
function StuckAfter() {
  const saved = useTopic('settings')?.stuckAfterMinutes;
  return (
    <TextSetting
      label="Stuck after (minutes)"
      saved={saved === undefined ? '' : String(saved)}
      width="8ch"
      save={(api, value) => api.invoke('settings.setStuckAfterMinutes', { minutes: Number(value.trim()) }).then((s) => String(s.stuckAfterMinutes))}
    >
      A Working Session whose agent says nothing for this long goes Waiting as stuck. Waiting on your answer or approval never counts.
    </TextSetting>
  );
}

/** Whether new Sessions send their Merge request's feedback straight to the agent. */
function AutoPromptDefault() {
  const api = useApi();
  const on = useTopic('settings')?.autoPromptDefault ?? false;
  const [error, setError] = useState<string>();
  const change = (next: boolean) => {
    setError(undefined);
    api.invoke('settings.setAutoPromptDefault', { on: next }).catch((e: unknown) => setError((e as Error).message));
  };
  return (
    <div style={{ padding: '10px 14px' }}>
      <label className="row">
        <input type="checkbox" checked={on} onChange={(event) => change(event.target.checked)} />
        <span>Auto-prompt new Sessions</span>
      </label>
      <div className="muted">New feedback on a Session's Merge request goes straight to its agent, up to {MAX_AUTO_PROMPTS} attempts in a row without a message from you. Each Session can change this from its Merge request, in the Glance strip.</div>
      <ErrorAlert error={error} />
    </div>
  );
}

/** Where new worktrees go; `~` is the home in each Project's Environment. */
function WorktreeRoot() {
  const saved = useTopic('settings')?.worktreeRoot ?? '';
  return (
    <TextSetting label="Worktree root" saved={saved} width="32ch" save={(api, worktreeRoot) => api.invoke('settings.setWorktreeRoot', { worktreeRoot }).then((s) => s.worktreeRoot)}>
      Each worktree Session gets a folder named after its branch: <span className="tech">{`${saved || '<root>'}/<project>/<session>`}</span>.
    </TextSetting>
  );
}

/** How Loom runs the user's editor and terminal, in each Session's Environment. */
function OpenCommands() {
  const settings = useTopic('settings');
  return (
    <>
      <TextSetting
        label="Editor command"
        saved={settings?.editorCommand ?? ''}
        width="40ch"
        save={(api, editorCommand) => api.invoke('settings.setEditorCommand', { editorCommand }).then((s) => s.editorCommand)}
      >
        Run in the Session's Environment with your shell's full PATH. <span className="tech">{'{path}'}</span> is the folder or file to open; without it, the path
        goes last.
      </TextSetting>
      <TextSetting
        label="Terminal command"
        saved={settings?.terminalCommand ?? ''}
        width="40ch"
        save={(api, terminalCommand) => api.invoke('settings.setTerminalCommand', { terminalCommand }).then((s) => s.terminalCommand)}
      >
        Runs in the working copy's folder, which it also gets wherever you write <span className="tech">{'{path}'}</span>, as in{' '}
        <span className="tech">{'wt -d {path}'}</span> or <span className="tech">{'kitty --directory {path}'}</span>.
      </TextSetting>
      <TextSetting
        label="Collapsed in the diff"
        saved={(settings?.diffCollapsedPatterns ?? []).join(', ')}
        width="40ch"
        save={(api, value) =>
          api.invoke('settings.setDiffCollapsedPatterns', { patterns: value.split(',') }).then((s) => s.diffCollapsedPatterns.join(', '))
        }
      >
        Files the Changes view starts collapsed, besides binaries and very large changes: comma-separated patterns on a file name, or on its path when they
        have a <span className="tech">/</span>, as in <span className="tech">*.lock</span>.
      </TextSetting>
    </>
  );
}

/** One text setting, saved on Enter or on leaving the field; shows why main rejected it. */
function TextSetting({
  label,
  saved,
  width,
  save: send,
  children,
}: {
  label: string;
  saved: string;
  width: string;
  /** Sends the new value to main; resolves with the value as main kept it. */
  save: (api: LoomApi, value: string) => Promise<string>;
  children: ReactNode;
}) {
  const api = useApi();
  const [value, setValue] = useState(saved);
  const [error, setError] = useState<string>();
  useEffect(() => setValue(saved), [saved]);

  // Enter submits, then leaving the field blurs it: save each value once.
  const sent = useRef<string>(undefined);
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (value === saved || value === sent.current) return;
    sent.current = value;
    setError(undefined);
    send(api, value)
      .then(setValue)
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => (sent.current = undefined));
  };
  return (
    <form onSubmit={save} style={{ padding: '10px 14px' }}>
      <label className="row">
        <span>{label}</span>
        <input
          className="tech prefix"
          style={{ width }}
          aria-label={label}
          value={value}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => save()}
        />
      </label>
      <div className="muted">{children}</div>
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

function EnvironmentRow({ env }: { env: EnvironmentStatus }) {
  const api = useApi();
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string>();
  const reload = () => {
    setReloading(true);
    setReloadError(undefined);
    api
      .invoke('environments.reload', { id: env.id })
      .catch((error: unknown) => setReloadError((error as Error).message))
      .finally(() => setReloading(false));
  };
  const warnings = [shellWarning(env), env.agent && agentWarning(env.agent)].filter((w): w is string => !!w);
  return (
    <tr>
      <td>{env.label}</td>
      <td>
        <span className={`row st-${env.state}`}>
          <StateIcon state={env.state} />
          <span>{env.state}</span>
        </span>
        {env.error && <div className="err">{env.error}</div>}
      </td>
      <td>
        {env.agent ? <AgentCell agent={env.agent} /> : <span className="muted">—</span>}
        {warnings.map((warning) => (
          <div key={warning} className="warn" role="alert">
            {warning}
          </div>
        ))}
      </td>
      <td>{env.bridge ? <span className="tech">{`loom-bridge ${env.bridge.version}`}</span> : <span className="muted">—</span>}</td>
      <td>
        <button
          type="button"
          title="Re-read your shell environment, for tools installed since Loom started"
          disabled={reloading || env.state !== 'connected'}
          onClick={reload}
        >
          <span className={reloading ? 'spin' : undefined}>
            <RotateCw className="sm" />
          </span>
          Reload
        </button>
        {reloadError && <div className="err">{reloadError}</div>}
      </td>
    </tr>
  );
}

function AgentCell({ agent }: { agent: AgentStatus }) {
  const label = agent.checking ? 'checking' : agent.state;
  return (
    <>
      <div className="tech" title={agent.path}>
        {agent.version ? `${agent.name} ${agent.version}` : agent.name}
      </div>
      <span className={`row ag-${agent.checking ? 'checking' : agent.state}`}>
        <AgentIcon agent={agent} />
        <span>{label}</span>
      </span>
    </>
  );
}

function AgentIcon({ agent }: { agent: AgentStatus }) {
  if (agent.checking) {
    return (
      <span className="spin">
        <LoaderCircle className="sm" />
      </span>
    );
  }
  switch (agent.state) {
    case 'ready':
      return <CircleCheckBig className="sm" />;
    case 'unknown':
      return null;
    case 'signed-out':
    case 'unsupported':
      return <TriangleAlert className="sm" />;
    case 'missing':
    case 'error':
      return <CircleX className="sm" />;
  }
}

/** What to fix before the agent can run Sessions, if anything. */
function agentWarning(agent: AgentStatus): string | undefined {
  const install = `Install OpenCode ${OPENCODE_MIN_VERSION} or later, then Reload.`;
  switch (agent.state) {
    case 'missing':
      return `OpenCode isn't installed in this Environment, or isn't on your shell's PATH. ${install}`;
    case 'unsupported':
      return agent.version?.startsWith('1.')
        ? `OpenCode ${agent.version} is V1 OpenCode (opencode-ai), which is not supported. ${install}`
        : `OpenCode ${agent.version} is too old. ${install}`;
    case 'signed-out':
      return "OpenCode isn't signed in to any model provider. Sign in from OpenCode; Loom checks again whenever Settings opens.";
    case 'error':
      return `Loom couldn't check OpenCode: ${agent.error}`;
    default:
      return undefined;
  }
}

/** Native Windows has no login shell, so only other Environments warn. */
function shellWarning(env: EnvironmentStatus): string | undefined {
  if (env.shellEnvironment !== 'bridge' || env.bridge?.os === 'windows') return undefined;
  return "Loom couldn't read your login shell's environment, so tools set up in your shell profile (mise, asdf, ~/.local/bin) may not be found.";
}

function StateIcon({ state }: { state: EnvironmentState }) {
  switch (state) {
    case 'connected':
      return <CircleCheckBig className="sm" />;
    case 'starting':
      return (
        <span className="spin">
          <LoaderCircle className="sm" />
        </span>
      );
    case 'unresponsive':
      return <TriangleAlert className="sm" />;
    case 'disconnected':
    case 'failed':
      return <CircleX className="sm" />;
  }
}
