import { ArchiveRestore, CircleCheckBig, CircleX, FolderGit2, FolderOpen, GitBranch, LoaderCircle, MessageSquarePlus, Palette, Search, Trash2, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FORGE_CLI, FORGE_NAMES, OPENCODE_NAME, type Commands, type EnvironmentStatus, type ForgeStatus, type ModelPick, type Project, type ProjectEdit, type RestorableProject, type UnsavedSession } from '../shared/api';
import { distroOf, NATIVE_ENVIRONMENT_ID, onWindowsDrive } from '../shared/environment-ids';
import { branchPrefixError, branchPrefixOf, defaultBranchError, defaultBranchOf } from '../shared/branches';
import { AVATAR_MAX, avatarError, avatarText, PROJECT_COLOR_NAMES, PROJECT_COLORS, projectNameError, type ProjectColor } from '../shared/projects';
import { ErrorText } from './ErrorText';
import { useApi, useTopic } from './api';
import { unsavedWorkSummary } from './Archive';
import { useCheckoutModels } from './checkout';
import { copyable } from './ContextMenu';
import { effortsOf, ModelPickers } from './ModelPicker';
import { ProjectAvatar, projectColor } from './ProjectAvatar';
import { filterProjects } from './ProjectPicker';
import { SaveFeedback, Setting, TextSetting, useSaving } from './SettingControls';
import { SHORTCUTS } from './shortcuts';


/** A Project the user just added, or restored, which a Session can start in next. */
export interface AddedProject {
  project: Project;
  restored: boolean;
}

/** Adding a Project from a folder the user chooses, and how the last attempt went. */
export interface ProjectAdder {
  linking: boolean;
  /** Why the last attempt failed. */
  error?: string;
  /** The Project the last attempt added or restored. */
  added?: AddedProject;
  /**
   * Asks for a folder and links its checkout; does nothing if the user
   * cancels. A checkout of a removed Project first asks whether to restore it.
   */
  link(): Promise<void>;
  /** Clears the last attempt's error or Project added, and any open restore offer; an attempt still running then ends silently. */
  dismiss(): void;
  /** The offer to restore a removed Project, while one is open; render it anywhere. */
  dialog: ReactNode;
}

export function useProjectAdder(): ProjectAdder {
  const api = useApi();
  const environments = useTopic('environments') ?? [];
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<AddedProject>();
  const [choosing, setChoosing] = useState(false);
  const [offer, setOffer] = useState<{ checkout: CheckoutPick; project: RestorableProject }>();
  // Bumped by dismiss, so an attempt that fails after it doesn't show its error.
  const attempt = useRef(0);
  /** Runs an attempt, which resolves with the Project it added or restored, if it did. */
  const run = async (action: () => Promise<AddedProject | undefined>) => {
    setError(undefined);
    setAdded(undefined);
    setLinking(true);
    const current = attempt.current;
    try {
      const result = await action();
      if (result && attempt.current === current) setAdded(result);
    } catch (e) {
      if (attempt.current === current) setError((e as Error).message);
    } finally {
      setLinking(false);
    }
  };
  const linkIn = (environmentId: string) =>
    run(async () => {
      const inWsl = environmentId !== NATIVE_ENVIRONMENT_ID;
      const path = await api.invoke('dialogs.chooseFolder', inWsl ? { environmentId } : undefined);
      if (!path) return undefined;
      const checkout: CheckoutPick = inWsl ? { path, environmentId } : { path };
      const project = await api.invoke('projects.restorable', checkout);
      if (!project) return { project: await api.invoke('projects.link', checkout), restored: false };
      setOffer({ checkout, project });
      return undefined;
    });
  const distros = environments.filter((e) => e.distro && e.state !== 'failed');
  const link = async () => {
    const hasWsl = distros.length > 0;
    if (hasWsl) setChoosing(true);
    else await linkIn(NATIVE_ENVIRONMENT_ID);
  };
  const answer = (restore: boolean) => {
    if (!offer) return;
    setOffer(undefined);
    void run(async () => ({
      project: await api.invoke('projects.link', restore ? { ...offer.checkout, restore: offer.project.id } : offer.checkout),
      restored: restore,
    }));
  };
  const chosen = (environmentId: string) => {
    setChoosing(false);
    void linkIn(environmentId);
  };
  const dialog = choosing ? (
    <EnvironmentChoice distros={distros} onChoose={chosen} onCancel={() => setChoosing(false)} />
  ) : (
    offer && <RestoreOffer project={offer.project} onRestore={() => answer(true)} onNew={() => answer(false)} onCancel={() => setOffer(undefined)} />
  );
  const dismiss = useCallback(() => {
    attempt.current++;
    setError(undefined);
    setAdded(undefined);
    setChoosing(false);
    setOffer(undefined);
  }, []);
  return { linking, error, added, link, dismiss, dialog };
}

/** A checkout to link: its folder, and its Environment unless native. */
type CheckoutPick = Commands['projects.restorable']['params'];

/** Asks where a checkout's work runs: natively on Windows or in one of the WSL distros, the first preselected. */
function EnvironmentChoice({ distros, onChoose, onCancel }: { distros: EnvironmentStatus[]; onChoose: (environmentId: string) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState(distros[0]!.id);
  const name = useId();
  const choose = useRef<HTMLButtonElement>(null);
  useEffect(() => choose.current?.focus(), []);
  const options = [{ id: NATIVE_ENVIRONMENT_ID, label: 'Windows' }, ...distros.map((d) => ({ id: d.id, label: `${d.label} (WSL)` }))];
  return (
    <div className="scrim" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="card modal" role="dialog" aria-modal="true" aria-labelledby={`${name}-title`} aria-describedby={`${name}-text`}>
        <div className="card-head">
          <FolderGit2 className="sm" />
          <h3 id={`${name}-title`}>Where does the checkout's work run?</h3>
        </div>
        <p id={`${name}-text`}>Its agent, git and Forge CLI run there. A checkout in a WSL distro works fastest in the distro's own folders.</p>
        <div className="environment-choice">
          {options.map((option) => (
            <label key={option.id} className="row">
              <input type="radio" name={name} checked={picked === option.id} onChange={() => setPicked(option.id)} />
              {option.label}
            </label>
          ))}
        </div>
        <div className="row modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button ref={choose} type="button" className="primary" onClick={() => onChoose(picked)}>
            Choose the folder…
          </button>
        </div>
      </div>
    </div>
  );
}

/** Why a WSL checkout on a Windows drive (`/mnt/c/…`) is slow, and what to do instead. */
function SlowCheckout({ project }: { project: Project }) {
  const { environmentId, path } = project.checkout;
  const distro = distroOf(environmentId);
  if (!distro || !onWindowsDrive(path)) return null;
  return (
    <div className="warn page-note" role="note" aria-label="Slow checkout">
      <TriangleAlert className="sm" /> {path} is on a Windows drive: git and the agent are slow there from {distro}. For speed, clone it into {distro}'s own folders, like ~/code, and add that clone.
    </div>
  );
}

function RestoreOffer({ project, onRestore, onNew, onCancel }: { project: RestorableProject; onRestore: () => void; onNew: () => void; onCancel: () => void }) {
  const restore = useRef<HTMLButtonElement>(null);
  useEffect(() => restore.current?.focus(), []);
  const archived = project.sessions === 1 ? '1 archived Session' : `${project.sessions} archived Sessions`;
  // A Project removed before it had a Session has none to bring back: saying "its 0" would read as a loss.
  const restoredWith = project.sessions === 0 ? 'its usage history' : `its ${archived} and usage history`;
  return (
    <div className="scrim" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="card modal" role="alertdialog" aria-modal="true" aria-labelledby="restore-title" aria-describedby="restore-text">
        <div className="card-head">
          <ArchiveRestore className="sm" />
          <h3 id="restore-title">Restore {project.name}?</h3>
        </div>
        <p id="restore-text">
          This checkout is of a Project you removed. Restore {project.name} with {restoredWith}, or start a new Project?
        </p>
        <div className="row modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onNew}>
            New Project
          </button>
          <button ref={restore} type="button" className="primary" onClick={onRestore}>
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}

// Laid out like Settings: the list of Projects beside, under the title and a
// way to add one; the Project picked from it on the page, its settings in
// cards, each saved as it changes. Only the page scrolls, so the list stays in
// sight. The adder is shared with the sidebar's + menu, whose result shows here.
export function Projects({ adder, onStartSession }: { adder: ProjectAdder; onStartSession: (project: Project) => void }) {
  const api = useApi();
  const projects = useTopic('projects') ?? [];
  const environments = useTopic('environments') ?? [];
  // Opening Projects checks the Forges again, so what it shows is current.
  useEffect(() => {
    api.invoke('projects.check').catch((error: unknown) => console.error('Forge detection failed:', error));
  }, [api]);
  // An error from adding a Project, the next step after adding one, or an offer to restore one, goes when the user leaves the page.
  const { dismiss } = adder;
  useEffect(() => dismiss, [dismiss]);

  const [picked, setPicked] = useState<number>();
  const [filter, setFilter] = useState('');
  // A Project just added or restored is the one to set up next.
  const addedId = adder.added?.project.id;
  const [seenAdded, setSeenAdded] = useState(addedId);
  if (addedId !== seenAdded) {
    setSeenAdded(addedId);
    if (addedId !== undefined) {
      setPicked(addedId);
      setFilter('');
    }
  }
  // The Project picked, while there is one; else, as when it was removed, the first.
  const selected = projects.find((p) => p.id === picked) ?? projects[0];
  const listed = filterProjects(projects, filter);
  const page = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  // Each Project's settings start at their top. Focus lost with the last
  // one's (as with a Project just removed) goes to the one now shown, in the list.
  useEffect(() => {
    if (page.current) page.current.scrollTop = 0;
    if (document.activeElement === document.body) nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }, [selected?.id]);
  const onFilterKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && listed[0]) {
      event.preventDefault();
      setPicked(listed[0].id);
    } else if (event.key === 'Escape' && filter) {
      event.stopPropagation();
      setFilter('');
    }
  };

  const environmentLabel = (id: string) => environments.find((e) => e.id === id)?.label ?? id;
  return (
    <div className="settings projects-page">
      <div className="settings-layout">
        <aside className="settings-side">
          <h1>Projects</h1>
          <button className={adder.added ? undefined : 'primary'} type="button" disabled={adder.linking} onClick={() => void adder.link()}>
            <FolderOpen className="sm" />
            {SHORTCUTS.addProject.label}
          </button>
          {projects.length > FILTER_FROM && (
            <label className="settings-search">
              <Search className="sm" />
              <input type="search" aria-label="Filter Projects" placeholder="Filter Projects" value={filter} spellCheck={false} onChange={(event) => setFilter(event.target.value)} onKeyDown={onFilterKey} />
            </label>
          )}
          {projects.length > 0 && (
            <nav ref={nav} className="settings-nav" aria-label="Projects">
              {listed.map((project) => (
                <ProjectNavItem key={project.id} project={project} current={project.id === selected?.id} onPick={() => setPicked(project.id)} />
              ))}
              {listed.length === 0 && <div className="muted project-nav-none">No Project matches “{filter.trim()}”.</div>}
            </nav>
          )}
        </aside>
        <div className="settings-sections" ref={page}>
          {adder.dialog}
          {adder.added && <NextStep added={adder.added} onDismiss={dismiss} />}
          {adder.error && (
            <div className="row page-error">
              <div className="err" role="alert">
                <ErrorText text={adder.error} />
              </div>
              <button className="icon-btn sm" type="button" title="Dismiss" aria-label="Dismiss" onClick={dismiss}>
                <X />
              </button>
            </div>
          )}
          {selected ? (
            <ProjectSettings key={selected.id} project={selected} environmentLabel={environmentLabel(selected.checkout.environmentId)} justAdded={addedId === selected.id} onStartSession={() => onStartSession(selected)} />
          ) : (
            <div className="card">
              <div className="empty">
                <FolderGit2 className="sm" />
                No Projects yet. Add a git checkout on this machine with "{SHORTCUTS.addProject.label}".
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** How many Projects the list shows before it has a filter. */
const FILTER_FROM = 6;

/** A Project in the list: its avatar and name, and a mark when its Forge features are off for a reason the user can fix. */
function ProjectNavItem({ project, current, onPick }: { project: Project; current: boolean; onPick: () => void }) {
  return (
    <button type="button" aria-current={current ? 'page' : undefined} title={project.checkout.path} onClick={onPick}>
      <ProjectAvatar project={project} size={20} />
      <span className="ellipsis">{project.name}</span>
      {forgeNeedsFixing(project.forge) && (
        <>
          <TriangleAlert className="sm project-nav-warn" aria-hidden="true" />
          <span className="sr-only">, Forge features off</span>
        </>
      )}
    </button>
  );
}

/** The way on after adding a Project: setting it up, then a Session in it, from its page's head. */
function NextStep({ added: { project, restored }, onDismiss }: { added: AddedProject; onDismiss: () => void }) {
  return (
    <>
      <div className="row page-note">
        <span role="status">
          {restored ? 'Restored' : 'Added'} {project.name}.
        </span>
        <span className="muted">Check its settings below, then start a Session in it.</span>
        <span className="grow" />
        <button className="icon-btn sm" type="button" title="Dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <X />
        </button>
      </div>
      <SlowCheckout project={project} />
    </>
  );
}

/** A Project's settings: what it is called and looks like, where its checkout is, how its Sessions start, and removing it. */
function ProjectSettings({ project, environmentLabel, justAdded, onStartSession }: { project: Project; environmentLabel: string; justAdded: boolean; onStartSession: () => void }) {
  const api = useApi();
  const id = `project-${project.id}`;
  const reason = forgeOffReason(project.forge, environmentLabel);
  const edit: EditProject = (change) => api.invoke('projects.edit', { id: project.id, ...change });
  return (
    <>
      <header className="project-header">
        <ProjectAvatar project={project} size={36} />
        <div className="project-header-text">
          <h2 className="ellipsis" title={project.name}>
            {project.name}
          </h2>
          <span className="tech muted ellipsis" title={project.checkout.path} {...copyable('path', project.checkout.path)}>
            {project.checkout.path}
          </span>
        </div>
        {/* Once a Project is added, starting a Session in it is the next step. */}
        <button className={justAdded ? 'primary' : undefined} type="button" onClick={onStartSession}>
          <MessageSquarePlus className="sm" />
          Start a Session
        </button>
      </header>

      <SettingsCard id={`${id}-general`} icon={Palette} title="General">
        <Setting title="Name" description="How the Project shows in the Inbox, the Dashboard and the Project picker.">
          <TextSetting label="Name" stored={project.name} width="24ch" check={projectNameError} save={(_, name) => edit({ name }).then((p) => p.name)} />
        </Setting>
        <Setting title="Colour" description="Marks the Project's Sessions wherever they show." wide>
          <ProjectColorPicker color={project.color} edit={edit} />
        </Setting>
        <Setting title="Avatar" description={`Up to ${AVATAR_MAX} characters, or an emoji. Empty, the name's first letters.`}>
          <TextSetting
            label="Avatar"
            stored={project.avatar ?? ''}
            width="8ch"
            placeholder={avatarText({ name: project.name })}
            check={avatarError}
            save={(_, avatar) => edit({ avatar: avatar.trim() || null }).then((p) => p.avatar ?? '')}
          />
        </Setting>
      </SettingsCard>

      <SettingsCard id={`${id}-sessions`} icon={GitBranch} title="New Sessions">
        <Setting title="Branch prefix" description="What the branch of each new worktree Session starts with.">
          <TextSetting
            label="Branch prefix"
            stored={project.branchPrefix}
            width="16ch"
            check={branchPrefixError}
            hint={(value) => (branchPrefixError(value) ? 'Not a valid branch prefix' : <span className="tech">{`${branchPrefixOf(value)}/<session>`}</span>)}
            save={(_, branchPrefix) => api.invoke('projects.setBranchPrefix', { id: project.id, branchPrefix }).then((p) => p.branchPrefix)}
          />
        </Setting>
        <Setting title="Default branch" description="What new worktree Sessions branch from, on origin or else local, and what Changes compares with when where a branch started isn't known. Empty, origin's default branch.">
          <TextSetting
            label="Default branch"
            stored={project.defaultBranch ?? ''}
            width="16ch"
            placeholder="git's own"
            check={defaultBranchError}
            save={(_, branch) => edit({ defaultBranch: defaultBranchOf(branch) || null }).then((p) => p.defaultBranch ?? '')}
          />
        </Setting>
        <Setting title="Default model" description={`New Sessions in ${project.name} start on it, until another is picked.`}>
          <DefaultModelPicker project={project} edit={edit} />
        </Setting>
      </SettingsCard>

      <SettingsCard id={`${id}-checkout`} icon={FolderGit2} title="Checkout">
        <Setting title="Folder" description="The git checkout the Project's Sessions work in, or branch their worktrees from." wide>
          <span className="tech project-path" {...copyable('path', project.checkout.path)}>
            {project.checkout.path}
          </span>
        </Setting>
        <Setting title="Environment" description="Where the Project's agent, git and Forge CLI run.">
          <span>{environmentLabel}</span>
        </Setting>
        <Setting title="Forge" description="Issues, Merge requests and Babysit, through the Forge's CLI.">
          <div className="project-forge">
            <ForgeCell forge={project.forge} />
          </div>
          {reason && (
            <div className="warn project-forge-reason" role="note">
              {reason}
            </div>
          )}
        </Setting>
      </SettingsCard>

      <SettingsCard id={`${id}-remove`} icon={Trash2} title="Remove">
        <Setting title={`Remove ${project.name}`} description="Loom forgets the Project; its folder stays on disk and its Sessions are Archived, read-only. Adding a checkout of it again offers to restore it.">
          <RemoveProject project={project} />
        </Setting>
      </SettingsCard>
    </>
  );
}

/** A card of a Project's settings, as Settings' sections are. */
function SettingsCard({ id, icon: Icon, title, children }: { id: string; icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="card settings-section" aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <Icon className="sm" />
        <h2 id={`${id}-title`}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** Saves a change to the Project shown; resolves with the Project as main kept it. */
type EditProject = (change: Omit<ProjectEdit, 'id'>) => Promise<Project>;

/** The Project's colour, saved as soon as one is picked. */
function ProjectColorPicker({ color, edit }: { color: ProjectColor; edit: EditProject }) {
  const { save, saved, error } = useSaving();
  const name = useId();
  return (
    <>
      <div role="radiogroup" aria-label="Colour" className="accent-picker">
        {PROJECT_COLOR_NAMES.map((choice) => (
          <label key={choice} className="accent-option">
            <input
              type="radio"
              className="sr-only"
              name={name}
              checked={color === choice}
              onChange={() => void save(edit({ color: choice }))}
            />
            <span className="accent-swatch" aria-hidden="true" style={{ background: projectColor({ color: choice }) }} />
            {PROJECT_COLORS[choice].label}
          </label>
        ))}
      </div>
      <SaveFeedback saved={saved} error={error} />
    </>
  );
}

/** The model new Sessions in the Project start on, saved as soon as it, or its Effort level, is picked. */
function DefaultModelPicker({ project, edit }: { project: Project; edit: EditProject }) {
  const models = useCheckoutModels(project.id);
  const { save, saved, error } = useSaving();
  const pick = project.defaultModel;
  const change = (defaultModel: ModelPick | null) => void save(edit({ defaultModel }));
  return (
    <>
      <div className="row project-model">
        <ModelPickers
          agent={OPENCODE_NAME}
          models={models.listed}
          model={pick?.model}
          efforts={effortsOf(models.listed, pick?.model)}
          effort={pick?.effort}
          onOpen={models.refresh}
          // A new model starts on its own Effort level.
          onModel={(model) => change({ model })}
          onEffort={(effort) => pick && change({ model: pick.model, effort })}
        />
      </div>
      {pick && (
        <button type="button" className="link project-model-reset" onClick={() => change(null)}>
          Use {OPENCODE_NAME}'s own
        </button>
      )}
      <SaveFeedback saved={saved} error={error} />
    </>
  );
}

/** The Remove button, and the dialogs it opens: Remove? then, with unsaved work, Discard and remove? */
function RemoveProject({ project }: { project: Project }) {
  const api = useApi();
  const sessions = (useTopic('sessions') ?? []).filter((s) => s.projectId === project.id);
  const [step, setStep] = useState<{ unsaved?: UnsavedSession[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelButton.current?.focus(), [step]);
  const close = () => {
    setStep(undefined);
    setError(undefined);
  };
  const remove = (discard: boolean) => {
    setError(undefined);
    setBusy(true);
    api
      .invoke('projects.remove', discard ? { id: project.id, discard } : { id: project.id })
      .then((result) => (result.removed ? close() : setStep({ unsaved: result.unsaved })))
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const open = sessions.filter((s) => s.status !== 'archived').length;
  const count = sessions.length === 1 ? '1 Session' : `${sessions.length} Sessions`;
  const unsaved = step?.unsaved;
  return (
    <>
      <button className="sm" type="button" title={`Remove ${project.name}`} aria-label={`Remove ${project.name}`} onClick={() => setStep({})}>
        Remove
      </button>
      {step && (
        <div className="scrim" onKeyDown={(e) => e.key === 'Escape' && close()}>
          <div className="card modal" role="alertdialog" aria-modal="true" aria-labelledby={`remove-${project.id}-title`} aria-describedby={`remove-${project.id}-text`}>
            <div className="card-head">
              <TriangleAlert className="sm warn-icon" />
              <h3 id={`remove-${project.id}-title`}>{unsaved ? `Remove ${project.name} with unsaved work?` : `Remove ${project.name}?`}</h3>
            </div>
            {unsaved ? (
              <div id={`remove-${project.id}-text`}>
                <p>These Sessions' worktrees have unsaved work. Removing the Project removes the worktrees and discards their changes; commits stay on their local branches.</p>
                <ul>
                  {unsaved.map((u) => (
                    <li key={u.sessionId}>
                      <b>{u.title}</b>: {unsavedWorkSummary(u.unsavedWork)}
                      {u.unsavedWork.detached && u.unsavedWork.unpushedCommits > 0 && ', on no branch, so those commits will be lost'}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p id={`remove-${project.id}-text`}>
                Loom forgets this Project; the folder at <span className="tech">{project.checkout.path}</span> stays on disk.{' '}
                {sessions.length > 0 && (
                  <>
                    Its {count} {open > 0 && `(${open} still Working or Waiting, which are archived first) `}stay in the Archive, read-only.{' '}
                  </>
                )}
                Adding a checkout of it again offers to restore it.
              </p>
            )}
            {error && (
              <div className="err" role="alert">
                <ErrorText text={error} />
              </div>
            )}
            <div className="row modal-actions">
              <button ref={cancelButton} type="button" onClick={close}>
                Cancel
              </button>
              <button type="button" className="danger" disabled={busy} onClick={() => remove(!!unsaved)}>
                {unsaved ? 'Discard and remove' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** How the Forge cell shows a Forge status: its colour, its label and, for a normal setup with the features off, why. */
function forgeLook(forge: ForgeStatus): { look: string; label: string; reason?: string } {
  if (forge.checking) return { look: 'checking', label: 'checking' };
  switch (forge.state) {
    case 'available':
      return { look: 'available', label: 'available' };
    case 'unknown':
      return { look: 'unknown', label: 'not checked' };
    case 'no-remote':
      return { look: 'local', label: 'Local only', reason: 'This checkout has no origin remote, so Forge features (issues, Merge requests, Babysit) are off.' };
    case 'unsupported':
      return { look: 'local', label: 'No Forge', reason: `origin${forge.remote ? ` (${forge.remote})` : ''} isn't on GitHub or GitLab, so Forge features (issues, Merge requests, Babysit) are off.` };
    default:
      return { look: 'off', label: 'off' };
  }
}

function ForgeCell({ forge }: { forge: ForgeStatus }) {
  const { look, label, reason } = forgeLook(forge);
  return (
    <>
      {forge.kind && (
        <div>
          {FORGE_NAMES[forge.kind]} {forge.repository && <span className="tech">{forge.repository}</span>}
        </div>
      )}
      {/* Focusable when it has a reason, so the keyboard can reach its tooltip too. */}
      <span className={`row fg-${look}`} title={reason} tabIndex={reason ? 0 : undefined}>
        <ForgeIcon forge={forge} />
        <span>{label}</span>
      </span>
    </>
  );
}

function ForgeIcon({ forge }: { forge: ForgeStatus }) {
  if (forge.checking) {
    return (
      <span className="spin">
        <LoaderCircle className="sm" />
      </span>
    );
  }
  switch (forge.state) {
    case 'available':
      return <CircleCheckBig className="sm" />;
    case 'unknown':
    case 'no-remote':
    case 'unsupported':
      return null;
    case 'cli-missing':
    case 'signed-out':
      return <TriangleAlert className="sm" />;
    case 'error':
      return <CircleX className="sm" />;
  }
}

/** Whether the Project's Forge features are off for a reason the user can fix (forgeOffReason says which). */
function forgeNeedsFixing(forge: ForgeStatus): boolean {
  return forge.state === 'cli-missing' || forge.state === 'signed-out' || forge.state === 'error';
}

/**
 * Why the Project's Forge features are off, and what to do about it, if they
 * are and the user can do something. A checkout with no origin remote, or
 * with one that isn't on GitHub or GitLab, is a normal setup: its cell says
 * so, and why on hover.
 */
function forgeOffReason(forge: ForgeStatus, environmentLabel: string): ReactNode {
  const command = forge.kind && FORGE_CLI[forge.kind];
  const cli = <span className="tech">{command}</span>;
  const recheck = 'Loom checks again whenever Projects opens.';
  switch (forge.state) {
    case 'cli-missing':
      return (
        <>
          Forge features are off: {cli} isn't installed in {environmentLabel}, or isn't on your shell's PATH. Install it, then Reload the Environment in Settings.
        </>
      );
    case 'signed-out':
      return (
        <>
          Forge features are off: {cli} isn't signed in to <span className="tech">{forge.host}</span>. Run "
          <span className="tech">{`${command} auth login --hostname ${forge.host}`}</span>"; {recheck}
        </>
      );
    case 'error':
      return <ErrorText text={`Forge features are off: Loom couldn't check the Forge: ${forge.error}`} />;
    default:
      return undefined;
  }
}
