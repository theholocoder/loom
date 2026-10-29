// The Projects service: the git checkouts the user has added to Loom, kept in
// the database, and what each one's Environment reports about them.
import { DEFAULT_BRANCH_PREFIX, type ForgeStatus, type Project } from '../../shared/api';
import type { Clock } from '../clock';
import { exec, isNotFound, type BridgeCall, type ExecResult } from '../environments/exec';
import type { LoomDatabase } from '../storage/database';
import { detectForge, GIT_TIMEOUT_MS } from './forge';

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
}

const UNCHECKED: ForgeStatus = { state: 'unknown', checking: false };

export class Projects {
  private projects = new Map<number, Project>();
  /** Forge checks running, by Project id. */
  private checking = new Map<number, Promise<void>>();

  private constructor(private readonly options: ProjectsOptions) {}

  /** The Projects service, with the Projects already in the database. */
  static async load(options: ProjectsOptions): Promise<Projects> {
    const projects = new Projects(options);
    const rows = await options.db
      .selectFrom('projects')
      .innerJoin('checkouts', 'checkouts.project_id', 'projects.id')
      .select(['id', 'name', 'branch_prefix', 'environment_id', 'path'])
      .execute();
    for (const row of rows) {
      projects.projects.set(row.id, {
        id: row.id,
        name: row.name,
        branchPrefix: row.branch_prefix,
        checkout: { environmentId: row.environment_id, path: row.path },
        forge: UNCHECKED,
      });
    }
    return projects;
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  }

  async link({ path, environmentId = 'native' }: { path: string; environmentId?: string }): Promise<Project> {
    const environment = this.environment(environmentId);
    const topLevel = await topLevelOf(environment, path);
    const name = topLevel.split('/').filter(Boolean).pop() ?? topLevel;
    // Asked before and after inserting: a link of the same checkout running
    // alongside this one may get there first.
    const linked = () => this.list().find((p) => p.checkout.environmentId === environmentId && p.checkout.path === topLevel);
    const alreadyLinked = () => new Error(`${topLevel} is already the Project "${linked()?.name ?? name}"`);
    if (linked()) throw alreadyLinked();
    const id = await this.options.db.transaction().execute(async (trx) => {
      const { id } = await trx
        .insertInto('projects')
        .values({ name, branch_prefix: DEFAULT_BRANCH_PREFIX, created_at: this.options.clock.now() })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.insertInto('checkouts').values({ project_id: id, environment_id: environmentId, path: topLevel }).execute();
      return id;
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw alreadyLinked();
      throw error;
    });
    this.projects.set(id, { id, name, branchPrefix: DEFAULT_BRANCH_PREFIX, checkout: { environmentId, path: topLevel }, forge: UNCHECKED });
    this.publish();
    await this.checkForge(id);
    return this.projects.get(id)!;
  }

  async setBranchPrefix(id: number, branchPrefix: string): Promise<Project> {
    if (!this.projects.has(id)) throw new Error(`unknown Project ${id}`);
    const prefix = branchPrefix.trim();
    const problem = branchPrefixProblem(prefix);
    if (problem) throw new Error(`"${branchPrefix}" can't be a branch prefix: ${problem}`);
    await this.options.db.updateTable('projects').set({ branch_prefix: prefix }).where('id', '=', id).execute();
    this.update(id, { branchPrefix: prefix });
    return this.projects.get(id)!;
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

/**
 * Why git would refuse `<prefix>/<slug>` as a branch name, following
 * `git check-ref-format --branch`; undefined if it wouldn't.
 */
function branchPrefixProblem(prefix: string): string | undefined {
  if (!prefix) return 'it is empty';
  if (prefix.startsWith('-')) return "it starts with '-'";
  if (prefix === '@') return "it is '@'";
  // Control characters and DEL, then the characters git reserves.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(prefix)) return 'it contains a space, a control character or one of ~ ^ : ? * [ \\';
  if (prefix.includes('..')) return "it contains '..'";
  if (prefix.includes('@{')) return "it contains '@{'";
  const parts = prefix.split('/');
  if (parts.some((part) => part === '')) return "it starts or ends with '/', or contains '//'";
  if (parts.some((part) => part.startsWith('.'))) return "a part of it starts with '.'";
  if (parts.some((part) => part.endsWith('.lock'))) return "a part of it ends with '.lock'";
  return undefined;
}
