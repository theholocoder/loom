// The Projects service: the git checkouts the user has added to Loom, kept in
// the database, and what each one's Environment reports about them.
import { DEFAULT_BRANCH_PREFIX, type ForgeStatus, type Issue, type Project, type RemovedProject, type RestorableProject } from '../../shared/api';
import { branchPrefixError, branchPrefixOf } from '../../shared/branches';
import type { Clock } from '../clock';
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';
import type { LoomDatabase } from '../storage/database';
import { detectForge, GIT_TIMEOUT_MS, parseRemote } from './forge';
import { listIssues } from './issues';

/** What the Projects service needs from an Environment. */
export interface ProjectEnvironment {
  label: string;
  connected(): boolean;
  request: BridgeCall;
}

export interface ProjectsOptions {
  db: LoomDatabase;
  clock: Clock;
  environment: (id: string) => ProjectEnvironment | undefined;
  onChange: (projects: Project[]) => void;
  onRemovedChange: (removed: RemovedProject[]) => void;
}

const UNCHECKED: ForgeStatus = { state: 'unknown', checking: false };

export class Projects {
  private projects = new Map<number, Project>();
  private removed = new Map<number, RemovedProject>();
  /** Whether each Project's local files are trusted, once the user has said. */
  private trust = new Map<number, boolean>();
  /** Forge checks running, by Project id. */
  private checking = new Map<number, Promise<void>>();

  private constructor(private readonly options: ProjectsOptions) {}

  /** The Projects service, with the Projects already in the database. */
  static async load(options: ProjectsOptions): Promise<Projects> {
    const projects = new Projects(options);
    const rows = await options.db
      .selectFrom('projects')
      .innerJoin('checkouts', 'checkouts.project_id', 'projects.id')
      .select(['id', 'name', 'branch_prefix', 'trusted', 'environment_id', 'path'])
      .execute();
    for (const row of rows) {
      if (row.trusted !== null) projects.trust.set(row.id, row.trusted !== 0);
      projects.projects.set(row.id, {
        id: row.id,
        name: row.name,
        branchPrefix: row.branch_prefix,
        checkout: { environmentId: row.environment_id, path: row.path },
        forge: UNCHECKED,
      });
    }
    const removed = await options.db.selectFrom('projects').select(['id', 'name']).where('removed_at', 'is not', null).execute();
    for (const { id, name } of removed) projects.removed.set(id, { id, name });
    return projects;
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  }

  /** The Projects the user removed, by name. */
  listRemoved(): RemovedProject[] {
    return [...this.removed.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  }

  async link({ path, environmentId = 'native', restore }: { path: string; environmentId?: string; restore?: number }): Promise<Project> {
    const environment = this.environment(environmentId);
    const topLevel = await topLevelOf(environment, path);
    const name = topLevel.split('/').filter(Boolean).pop() ?? topLevel;
    // Asked before and after inserting: a link of the same checkout running
    // alongside this one may get there first.
    const linked = () => this.list().find((p) => p.checkout.environmentId === environmentId && p.checkout.path === topLevel);
    const alreadyLinked = () => new Error(`${topLevel} is already the Project "${linked()?.name ?? name}"`);
    if (linked()) throw alreadyLinked();
    if (restore !== undefined) {
      const match = await this.restorableAt(environment, environmentId, topLevel);
      if (match?.id !== restore) throw new Error(`${topLevel} can't restore that Project: it isn't a checkout of the same repository`);
    }
    const db = this.options.db;
    const row = await db.transaction().execute(async (trx) => {
      let project: { id: number; name: string; branch_prefix: string; trusted: number | null };
      if (restore === undefined) {
        project = await trx
          .insertInto('projects')
          .values({ name, branch_prefix: DEFAULT_BRANCH_PREFIX, created_at: this.options.clock.now() })
          .returning(['id', 'name', 'branch_prefix', 'trusted'])
          .executeTakeFirstOrThrow();
      } else {
        // Only still removed, in case a restore of it alongside got there first.
        const restored = await trx
          .updateTable('projects')
          .set({ removed_at: null, identity: null })
          .where('id', '=', restore)
          .where('removed_at', 'is not', null)
          .returning(['id', 'name', 'branch_prefix', 'trusted'])
          .executeTakeFirst();
        if (!restored) throw new Error('That Project is no longer removed.');
        project = restored;
      }
      await trx.insertInto('checkouts').values({ project_id: project.id, environment_id: environmentId, path: topLevel }).execute();
      return project;
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw alreadyLinked();
      throw error;
    });
    const { id } = row;
    if (row.trusted !== null) this.trust.set(id, row.trusted !== 0);
    this.removed.delete(id);
    this.projects.set(id, { id, name: row.name, branchPrefix: row.branch_prefix, checkout: { environmentId, path: topLevel }, forge: UNCHECKED });
    this.publish();
    if (restore !== undefined) this.publishRemoved();
    await this.checkForge(id);
    return this.projects.get(id)!;
  }

  /** The removed Project a link of the checkout containing `path` would restore, if any. */
  async restorable({ path, environmentId = 'native' }: { path: string; environmentId?: string }): Promise<RestorableProject | null> {
    // Nothing removed, nothing to ask git.
    if (this.removed.size === 0) return null;
    const environment = this.environment(environmentId);
    return this.restorableAt(environment, environmentId, await topLevelOf(environment, path));
  }

  private async restorableAt(environment: ProjectEnvironment, environmentId: string, checkout: string): Promise<RestorableProject | null> {
    if (this.removed.size === 0) return null;
    const identity = await identityOf(environment, environmentId, checkout);
    const match = await this.options.db
      .selectFrom('projects')
      .select(['id', 'name'])
      .select((eb) => eb.selectFrom('sessions').select((s) => s.fn.countAll<number>().as('n')).whereRef('sessions.project_id', '=', 'projects.id').as('sessions'))
      .where('removed_at', 'is not', null)
      .where('identity', '=', identity)
      .orderBy('removed_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return match ? { id: match.id, name: match.name, sessions: Number(match.sessions ?? 0) } : null;
  }

  /**
   * Hides a Project whose Sessions are all archived: drops its checkout and
   * records its identity, to restore it by. Its Sessions and usage stay.
   */
  async remove(id: number): Promise<void> {
    const project = this.projects.get(id);
    if (!project) throw new Error(`unknown Project ${id}`);
    const { environmentId, path } = project.checkout;
    const environment = this.options.environment(environmentId);
    // Offline, origin can't be read: the checkout's place stands in.
    const identity = environment?.connected() ? await identityOf(environment, environmentId, path).catch(() => placeIdentity(environmentId, path)) : placeIdentity(environmentId, path);
    await this.options.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('checkouts').where('project_id', '=', id).execute();
      await trx.updateTable('projects').set({ removed_at: this.options.clock.now(), identity }).where('id', '=', id).execute();
    });
    this.projects.delete(id);
    this.removed.set(id, { id, name: project.name });
    this.publish();
    this.publishRemoved();
  }

  async setBranchPrefix(id: number, branchPrefix: string): Promise<Project> {
    if (!this.projects.has(id)) throw new Error(`unknown Project ${id}`);
    const error = branchPrefixError(branchPrefix);
    if (error) throw new Error(error);
    const prefix = branchPrefixOf(branchPrefix);
    await this.options.db.updateTable('projects').set({ branch_prefix: prefix }).where('id', '=', id).execute();
    this.update(id, { branchPrefix: prefix });
    return this.projects.get(id)!;
  }

  /** Whether the agent may trust the Project's local files, as the user said; undefined until asked. */
  trusted(id: number): boolean | undefined {
    return this.trust.get(id);
  }

  /** Records whether the agent may trust the Project's local files, for all its Sessions: at once, then in the database. */
  async setTrusted(id: number, trusted: boolean): Promise<void> {
    if (!this.projects.has(id)) throw new Error(`unknown Project ${id}`);
    this.trust.set(id, trusted);
    await this.options.db.updateTable('projects').set({ trusted: trusted ? 1 : 0 }).where('id', '=', id).execute();
  }

  /**
   * Checks a Project's Forge again, unless its Environment is unknown or not
   * connected (it is checked when it connects). A check already running is
   * joined rather than repeated.
   */
  checkForge(id: number): Promise<void> {
    const running = this.checking.get(id);
    if (running) return running;
    const check = (async () => {
      const project = this.projects.get(id);
      const environment = project && this.options.environment(project.checkout.environmentId);
      if (!project || !environment?.connected()) return;
      this.update(id, { forge: { ...project.forge, checking: true } });
      const forge = await detectForge(environment.request, project.checkout.path);
      this.update(id, { forge: { ...forge, checking: false } });
    })().finally(() => this.checking.delete(id));
    this.checking.set(id, check);
    return check;
  }

  /** The open issues on the Project's Forge, matching `search` if given. */
  async issues(id: number, search?: string): Promise<Issue[]> {
    const project = this.projects.get(id);
    if (!project) throw new Error(`unknown Project ${id}`);
    const environment = this.environment(project.checkout.environmentId);
    if (!environment.connected()) throw new Error(`${environment.label} isn't connected.`);
    return listIssues(environment.request, project.forge, project.checkout.path, search);
  }

  /** Checks the Forge of every Project, or of those in the Environment `environmentId`. */
  async checkForges(environmentId?: string): Promise<void> {
    const ids = this.list()
      .filter((p) => environmentId === undefined || p.checkout.environmentId === environmentId)
      .map((p) => p.id);
    await Promise.all(ids.map((id) => this.checkForge(id)));
  }

  private update(id: number, change: Partial<Project>): void {
    const project = this.projects.get(id);
    if (!project) return;
    this.projects.set(id, { ...project, ...change });
    this.publish();
  }

  private environment(id: string): ProjectEnvironment {
    const environment = this.options.environment(id);
    if (!environment) throw new Error(`unknown Environment "${id}"`);
    return environment;
  }

  private publish(): void {
    this.options.onChange(this.list());
  }

  private publishRemoved(): void {
    this.options.onRemovedChange(this.listRemoved());
  }
}

/**
 * What tells a checkout's Project apart, to restore it by: `<host>/<repository>`
 * of its origin, when origin is a network remote, or else where it is.
 */
async function identityOf(environment: ProjectEnvironment, environmentId: string, checkout: string): Promise<string> {
  const result = await exec(environment.request, 'git', ['-C', checkout, 'remote', 'get-url', 'origin'], GIT_TIMEOUT_MS);
  const remote = result.exitCode === 0 ? parseRemote(result.stdout.trim()) : undefined;
  // Forges match owner and name whatever their case.
  return remote ? `${remote.host}/${remote.repository.toLowerCase()}` : placeIdentity(environmentId, checkout);
}

function placeIdentity(environmentId: string, checkout: string): string {
  return `${environmentId}:${checkout}`;
}

/** The top-level folder of the git checkout containing `path`, as git reports it. */
async function topLevelOf(environment: ProjectEnvironment, path: string): Promise<string> {
  let result: ExecResult;
  try {
    result = await exec(environment.request, 'git', ['-C', path, 'rev-parse', '--show-toplevel'], GIT_TIMEOUT_MS);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`git isn't installed in ${environment.label}, or isn't on your shell's PATH`);
    }
    throw error;
  }
  if (result.exitCode !== 0) throw new Error(`${path} is not a git repository`);
  return result.stdout.trim();
}
