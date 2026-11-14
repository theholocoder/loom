// Babysit: watches each open, linked Merge request while the Client runs, and
// brings what is new on it back to its Session. Nothing a poll sees reaches
// the Session straight away: feedback waits out a quiet window, so a burst is
// one wake-up, and everything waits for the agent to be done with its run.
import type { BabysitCheck, BabysitCi, BabysitStatus, EndedMergeRequestState, FeedbackInfo, FeedbackItem, MergeRequestState, Project, ReviewCount, ReviewThread, Session } from '../../shared/api';
import type { Clock, TimerHandle } from '../clock';
import type { BridgeCall } from '../environments/exec';
import { readMergeRequestActivity, type MergeRequestActivity } from '../projects/merge-request-activity';
import type { LoomDatabase } from '../storage/database';
import { Topic } from '../topic';

export const POLL_WHILE_CI_PENDING_MS = 60_000;
export const POLL_MS = 3 * 60_000;
export const QUIET_WINDOW_MS = 2 * 60_000;

/** What Babysit has for a Session: quiet notes, and maybe feedback to act on. */
export interface FeedbackDelivery {
  info: FeedbackInfo[];
  feedback?: { number: number; url: string; items: FeedbackItem[]; ci?: BabysitCi };
}

/** What Babysit needs of the Sessions it looks after. */
export interface BabysitSessions {
  list(): Session[];
  setBabysit(id: number, status: BabysitStatus | undefined): void;
  setMergeRequestState(id: number, state: MergeRequestState): void;
  /** Adds what is given to the Session; false if it must wait, the agent being mid-run. */
  deliverFeedback(id: number, delivery: FeedbackDelivery): Promise<boolean>;
  /** Archives the Session, or brings it to the user; false if it must wait, the agent being mid-run. */
  endMergeRequest(id: number, state: EndedMergeRequestState): Promise<boolean>;
}

export interface BabysitOptions {
  db: LoomDatabase;
  clock: Clock;
  sessions: BabysitSessions;
  project: (id: number) => Project | undefined;
  /** How to run things in the Environment, if it is one Loom has. */
  call: (environmentId: string) => BridgeCall | undefined;
}

/** What Babysit remembers of one Merge request; persisted whole. */
interface BabysitRecord {
  number: number;
  url: string;
  /** Whether a poll has seen what was there at link time. */
  baselined: boolean;
  /** The feedback and approvals already seen. */
  seen: string[];
  /** The finished CI run last reported. */
  ciReported?: string;
  conflictsReported: boolean;
  /** Feedback not given to the Session yet, and when its quiet window ends. */
  pending: FeedbackItem[];
  quietUntil?: number;
  info: FeedbackInfo[];
  ci?: BabysitCi;
  checks?: BabysitCheck[];
  reviews?: ReviewCount;
  threads?: ReviewThread[];
  lastPollAt?: number;
  stale: boolean;
  /** Merged or closed, as a poll found it, until the Session has been archived or told. */
  ended?: EndedMergeRequestState;
}

export class Babysit {
  private readonly records = new Map<number, BabysitRecord>();
  private readonly nextPolls = new Map<number, TimerHandle>();
  private readonly quietEnds = new Map<number, TimerHandle>();
  /** Each Session's open review threads, for those listening: off the Session, as they carry every comment's body. */
  private readonly threadTopics = new Map<number, Topic<ReviewThread[]>>();
  /** The polls under way, by Session and Merge request: a new link doesn't wait for the old one's. */
  private readonly polling = new Set<string>();
  private readonly flushing = new Set<number>();
  /** The Sessions the user has stopped watching: what was seen is kept, so turning back on catches up. */
  private readonly off = new Set<number>();
  /** Those to poll again as soon as the poll under way ends. */
  private readonly pollAgain = new Set<number>();
  private writes: Promise<unknown> = Promise.resolve();
  private stopped = false;

  private constructor(private readonly options: BabysitOptions) {}

  /** Picks up what was watched before; polls start with `pollAll`, once the Environment is up. */
  static async load(options: BabysitOptions): Promise<Babysit> {
    const babysit = new Babysit(options);
    const rows = await options.db.selectFrom('babysit').selectAll().execute();
    const saved = new Map(rows.map((row) => [row.session_id, JSON.parse(row.state) as BabysitRecord]));
    for (const session of options.sessions.list()) {
      const link = session.status === 'archived' ? undefined : session.mergeRequest;
      if (!link) continue;
      const known = saved.get(session.id);
      // One that ended with no watch kept, as on a reopened Session, is watched no more; one with a watch kept has its end to finish.
      if (!known && session.mergeRequestState !== undefined && session.mergeRequestState !== 'open') continue;
      const record = known?.url === link.url ? known : newRecord(link);
      babysit.records.set(session.id, record);
      if (session.babysitOff) {
        babysit.off.add(session.id);
        continue;
      }
      options.sessions.setBabysit(session.id, statusOf(record));
      if (record.pending.length) babysit.armQuietEnd(session.id, record);
    }
    // What was kept for a link that has gone since.
    for (const id of saved.keys()) if (!babysit.records.has(id)) babysit.write(() => options.db.deleteFrom('babysit').where('session_id', '=', id).execute());
    return babysit;
  }

  /** The Session's open review threads now, then as Babysit reads them again; none while Babysit isn't watching it. */
  subscribeThreads(id: number, listener: (threads: ReviewThread[]) => void): () => void {
    if (!this.options.sessions.list().some((s) => s.id === id)) throw new Error(`unknown Session ${id}`);
    let topic = this.threadTopics.get(id);
    if (!topic) this.threadTopics.set(id, (topic = new Topic(this.threadsOf(id))));
    return topic.subscribe(listener);
  }

  /** Takes in a change to the Sessions: a Merge request linked starts being watched at once, and a deleted Session's is forgotten. */
  sessionsChanged(list: Session[]): void {
    if (this.stopped) return;
    const ids = new Set(list.map((s) => s.id));
    for (const id of new Set([...this.records.keys(), ...this.threadTopics.keys()])) {
      if (ids.has(id)) continue;
      if (this.records.has(id)) this.forget(id);
      this.threadTopics.get(id)?.set([]);
      this.threadTopics.delete(id);
    }
    for (const session of list) {
      const link = session.status === 'archived' ? undefined : session.mergeRequest;
      const record = this.records.get(session.id);
      if (record && record.url !== link?.url) this.drop(session.id);
      if (!link) continue;
      if (this.records.has(session.id)) {
        this.followSwitch(session);
        void this.flush(session.id);
      } else if (session.mergeRequestState === 'open') {
        const fresh = newRecord(link);
        this.records.set(session.id, fresh);
        this.options.sessions.setBabysit(session.id, statusOf(fresh));
        this.save(session.id, fresh);
        void this.poll(session.id);
      }
    }
  }

  /** Stops or starts watching as the Session's switch has just been set, if it has. */
  private followSwitch({ id, babysitOff }: Session): void {
    const record = this.records.get(id)!;
    if (!!babysitOff === this.off.has(id)) return;
    if (babysitOff) {
      this.off.add(id);
      this.clearTimers(id);
      this.options.sessions.setBabysit(id, undefined);
      this.publishThreads(id);
      return;
    }
    this.off.delete(id);
    this.options.sessions.setBabysit(id, statusOf(record));
    this.publishThreads(id);
    if (record.pending.length) this.armQuietEnd(id, record);
    void this.poll(id);
  }

  /** Polls every watched Merge request now: at startup, and when the window gains focus. */
  pollAll(): void {
    if (this.stopped) return;
    // One that ended before a restart, but wasn't dealt with, is dealt with now.
    for (const [id, record] of this.records) void (record.ended ? this.flush(id) : this.poll(id));
  }

  /**
   * Polls one Session's Merge request now, just after the user merged it
   * from its Panel; again once a poll under way ends, as that one may have
   * read it before. False if Babysit isn't watching it.
   */
  pollNow(id: number): boolean {
    const record = this.records.get(id);
    if (this.stopped || !record || this.off.has(id)) return false;
    if (this.polling.has(`${id}:${record.url}`)) this.pollAgain.add(id);
    else void this.poll(id);
    return true;
  }

  /** Stops watching, and resolves once what was seen is written. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const handle of [...this.nextPolls.values(), ...this.quietEnds.values()]) this.options.clock.clearTimeout(handle);
    this.nextPolls.clear();
    this.quietEnds.clear();
    await this.writes;
  }

  private async poll(id: number): Promise<void> {
    const record = this.records.get(id);
    const session = this.options.sessions.list().find((s) => s.id === id);
    if (!record || !session || session.mergeRequestState !== 'open' || this.off.has(id)) return;
    const pollKey = `${id}:${record.url}`;
    if (this.polling.has(pollKey)) return;
    this.polling.add(pollKey);
    let activity: MergeRequestActivity | undefined;
    try {
      activity = await this.read(session, record);
    } catch {
      // Only the badge says so: a flaky network shouldn't disturb the Session.
    } finally {
      this.polling.delete(pollKey);
    }
    // What it read may be out of date already: the next read takes it in instead.
    if (this.pollAgain.delete(id)) return this.poll(id);
    if (this.stopped || this.records.get(id) !== record || this.off.has(id)) return;
    if (activity) this.takeIn(id, record, activity);
    else record.stale = true;
    // Threads before the Session's new lastPollAt: a thread resolved here stays hidden until the new list lands.
    if (activity) this.publishThreads(id);
    this.options.sessions.setBabysit(id, statusOf(record));
    this.save(id, record);
    if (activity && activity.state !== 'open') {
      this.clearTimers(id);
      record.ended = activity.state;
      this.save(id, record);
      this.options.sessions.setMergeRequestState(id, activity.state);
      return this.flush(id);
    }
    this.armNextPoll(id, record);
    if (activity) void this.flush(id);
  }

  private read(session: Session, record: BabysitRecord): Promise<MergeRequestActivity> {
    const project = this.options.project(session.projectId);
    const call = project && this.options.call(project.checkout.environmentId);
    if (!project || !call) return Promise.reject(new Error('its Environment is gone'));
    // In the Project's checkout: the Session's worktree may be gone.
    return readMergeRequestActivity(call, project.forge, project.checkout.path, record.number);
  }

  /** Works out what is new in `activity`, and adds it to what the Session is to be told. */
  private takeIn(id: number, record: BabysitRecord, activity: MergeRequestActivity): void {
    const now = this.options.clock.now();
    const baseline = !record.baselined;
    const seen = new Set(record.seen);
    const fresh = baseline ? [] : activity.feedback.filter(({ key }) => !seen.has(key)).map(({ item }) => item);
    const info: FeedbackInfo[] = baseline ? [] : activity.approvals.filter(({ key }) => !seen.has(key)).map(({ author, url }) => ({ event: 'approved', author, url }));

    const { ci } = activity;
    if ((ci.status === 'failed' || ci.status === 'passed') && ci.key !== record.ciReported) {
      record.ciReported = ci.key;
      if (ci.status === 'failed') fresh.push({ kind: 'ci-failed', checks: ci.failing });
      else if (!baseline) info.push({ event: 'ci-passed', url: record.url });
    }
    if (activity.conflicts === true && !record.conflictsReported) {
      record.conflictsReported = true;
      fresh.push({ kind: 'conflicts' });
    } else if (activity.conflicts === false) {
      record.conflictsReported = false;
    }

    // What has stopped being true by the time it would be told isn't worth waking anyone for.
    const replacedCi = fresh.some((item) => item.kind === 'ci-failed');
    record.pending = record.pending.filter((item) => (item.kind === 'conflicts' ? activity.conflicts !== false : item.kind !== 'ci-failed' || (ci.status === 'failed' && !replacedCi)));
    record.pending.push(...fresh);
    if (!record.pending.length) record.quietUntil = undefined;
    else if (fresh.length) {
      record.quietUntil = now + QUIET_WINDOW_MS;
      this.armQuietEnd(id, record);
    }
    record.info.push(...info);
    record.seen = [...activity.feedback, ...activity.approvals].map(({ key }) => key);
    record.baselined = true;
    record.ci = ci.status;
    record.checks = ci.checks;
    record.reviews = activity.reviews;
    record.threads = activity.threads;
    record.lastPollAt = now;
    record.stale = false;
    if (activity.state !== 'open') {
      record.pending = [];
      record.info = [];
      record.quietUntil = undefined;
    }
  }

  /** Gives the Session what is due. What it can't take yet is tried again as the Session changes. */
  private async flush(id: number): Promise<void> {
    const record = this.records.get(id);
    if (!record || this.stopped || this.flushing.has(id) || this.off.has(id)) return;
    if (record.ended) return this.end(id, record, record.ended);
    const quiet = record.pending.length > 0 && record.quietUntil !== undefined && record.quietUntil <= this.options.clock.now();
    if (!quiet && !record.info.length) return;
    const info = [...record.info];
    const items = quiet ? [...record.pending] : [];
    this.flushing.add(id);
    let delivered = false;
    try {
      delivered = await this.options.sessions.deliverFeedback(id, {
        info,
        ...(items.length ? { feedback: { number: record.number, url: record.url, items, ...(record.ci ? { ci: record.ci } : {}) } } : {}),
      });
    } catch (error) {
      console.error(`could not give Session ${id} its Merge request's feedback:`, error);
    } finally {
      this.flushing.delete(id);
    }
    if (!delivered || this.records.get(id) !== record) return;
    record.info = record.info.filter((entry) => !info.includes(entry));
    record.pending = record.pending.filter((entry) => !items.includes(entry));
    if (!record.pending.length) record.quietUntil = undefined;
    this.save(id, record);
  }

  /** Has the Session archived, or brought to the user, for its Merge request merged or closed; tried again as the Session changes. */
  private async end(id: number, record: BabysitRecord, state: EndedMergeRequestState): Promise<void> {
    this.flushing.add(id);
    let done = false;
    try {
      done = await this.options.sessions.endMergeRequest(id, state);
    } catch (error) {
      console.error(`could not archive Session ${id} for its Merge request ${state}:`, error);
    } finally {
      this.flushing.delete(id);
    }
    if (!done || this.records.get(id) !== record) return;
    record.ended = undefined;
    this.save(id, record);
  }

  private armNextPoll(id: number, record: BabysitRecord): void {
    const handle = this.nextPolls.get(id);
    if (handle !== undefined) this.options.clock.clearTimeout(handle);
    this.nextPolls.set(
      id,
      this.options.clock.setTimeout(() => {
        this.nextPolls.delete(id);
        void this.poll(id);
      }, record.ci === 'pending' ? POLL_WHILE_CI_PENDING_MS : POLL_MS),
    );
  }

  private armQuietEnd(id: number, record: BabysitRecord): void {
    const handle = this.quietEnds.get(id);
    if (handle !== undefined) this.options.clock.clearTimeout(handle);
    this.quietEnds.set(
      id,
      this.options.clock.setTimeout(() => {
        this.quietEnds.delete(id);
        void this.flush(id);
      }, Math.max(0, (record.quietUntil ?? 0) - this.options.clock.now())),
    );
  }

  private clearTimers(id: number): void {
    for (const timers of [this.nextPolls, this.quietEnds]) {
      const handle = timers.get(id);
      if (handle !== undefined) this.options.clock.clearTimeout(handle);
      timers.delete(id);
    }
  }

  /** Stops watching the Session's Merge request, as it is unlinked, another linked, or the Session archived. */
  private drop(id: number): void {
    this.forget(id);
    this.options.sessions.setBabysit(id, undefined);
    this.publishThreads(id);
  }

  /** Forgets what was seen of the Session's Merge request. */
  private forget(id: number): void {
    this.records.delete(id);
    this.off.delete(id);
    this.clearTimers(id);
    this.write(() => this.options.db.deleteFrom('babysit').where('session_id', '=', id).execute());
  }

  /** The Session's open review threads, as last read; none while Babysit isn't watching it. */
  private threadsOf(id: number): ReviewThread[] {
    return (!this.off.has(id) && this.records.get(id)?.threads) || [];
  }

  private publishThreads(id: number): void {
    this.threadTopics.get(id)?.set(this.threadsOf(id));
  }

  private save(id: number, record: BabysitRecord): void {
    const row = { session_id: id, state: JSON.stringify(record) };
    this.write(() =>
      this.options.db
        .insertInto('babysit')
        .values(row)
        .onConflict((oc) => oc.column('session_id').doUpdateSet({ state: row.state }))
        .execute(),
    );
  }

  /** Runs `write` after those before it; one that fails is only logged, the next poll saves again. */
  private write(write: () => Promise<unknown>): void {
    this.writes = this.writes.then(write).catch((error: unknown) => console.error('could not save Babysit state:', error));
  }
}

function newRecord({ number, url }: { number: number; url: string }): BabysitRecord {
  return { number, url, baselined: false, seen: [], conflictsReported: false, pending: [], info: [], stale: false };
}

function statusOf({ ci, checks, reviews, lastPollAt, stale }: BabysitRecord): BabysitStatus {
  return { stale, ...(ci ? { ci } : {}), ...(checks ? { checks } : {}), ...(reviews ? { reviews } : {}), ...(lastPollAt !== undefined ? { lastPollAt } : {}) };
}
