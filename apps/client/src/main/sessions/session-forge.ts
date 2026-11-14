// A Session's Forge: what Loom reads from, and does on, the Merge request and
// issue linked to a Session. It touches no Session state but the issue a
// link tool names, which it hands back to the Session service to link.
import type { ForgeLink, ForgeStatus, IssueDetails, MergeRequestDetails, MergeRequestDiff, MergeRequestState, Project, Session } from '../../shared/api';
import type { BridgeCall } from '../environments/exec';
import { issueNamed, readIssue, readNamedIssue } from '../projects/issues';
import { readMergeRequestDetails } from '../projects/merge-request-details';
import { readMergeRequestDiff } from '../projects/merge-request-diff';
import { replyToReviewThread, resolveReviewThread, squashAndMerge, viewMergeRequest } from '../projects/merge-requests';
import type { SessionEnvironment } from './sessions';

export interface SessionForgeOptions {
  /** The Session with this id, if Loom has it. */
  session: (id: number) => Session | undefined;
  project: (id: number) => Project | undefined;
  /** The Environment the Session runs in, if Loom has it. */
  environment: (session: Session) => Pick<SessionEnvironment, 'request' | 'tempDir'> | undefined;
  /** Links the Session to the issue `link`, as `sessions.linkIssue` does. */
  linkIssue: (id: number, link: ForgeLink) => void;
}

/** Where a Forge read runs: its Environment, its Project's Forge, and where glab runs. */
type ForgeRead = { call: BridgeCall; tempDir: () => string; forge: ForgeStatus | undefined; workingCopy: string };

export class SessionForge {
  private stopped = false;

  constructor(private readonly options: SessionForgeOptions) {}

  /** The Session's Merge request as its Forge has it now, read in its working copy, or the Project's checkout once that is gone. */
  async mergeRequest({ id }: { id: number }): Promise<MergeRequestDetails> {
    const { call, forge, workingCopy, number } = this.mergeRequestRead(this.get(id));
    return readMergeRequestDetails(call, forge, workingCopy, number);
  }

  /** The Session's Merge request's diff as its Forge has it now, read where `mergeRequest` reads it. */
  async mergeRequestDiff({ id }: { id: number }): Promise<MergeRequestDiff> {
    const { call, forge, workingCopy, number } = this.mergeRequestRead(this.get(id));
    return readMergeRequestDiff(call, forge, workingCopy, number);
  }

  /**
   * Squashes and merges the Session's Merge request, as the user confirmed in
   * its Panel: no Approval request, the user asked for it themselves. Then
   * says its state as the Forge has it, for whoever records it (Babysit, if
   * it watches the Merge request).
   */
  async squashAndMerge({ id, title, head }: { id: number; title: string; head: string }): Promise<{ state?: MergeRequestState }> {
    const session = this.get(id);
    if (session.status === 'archived') throw new Error('This Session is archived.');
    // A commit title is one line.
    const subject = title.replace(/\s+/g, ' ').trim();
    if (!subject) throw new Error('The squash commit needs a title.');
    if (!head) throw new Error("Loom doesn't know which commit the Merge request is at: read it again first.");
    const { call, forge, workingCopy, number } = this.mergeRequestRead(session);
    await squashAndMerge(call, forge, workingCopy, number, { title: subject, head });
    try {
      return { state: (await viewMergeRequest(call, forge, workingCopy, number)).state };
    } catch {
      // Merged all the same: the next read says how it stands.
      return {};
    }
  }

  /** Replies to a review thread of the Session's Merge request, as the user wrote it in its note on the diff. */
  async replyToReviewThread({ id, thread, body }: { id: number; thread: string; body: string }): Promise<void> {
    const session = this.get(id);
    if (session.status === 'archived') throw new Error('This Session is archived.');
    if (typeof body !== 'string' || !body.trim()) throw new Error('The reply is empty.');
    const { call, tempDir, forge, workingCopy, number } = this.mergeRequestRead(session);
    await replyToReviewThread(call, forge, workingCopy, tempDir(), number, String(thread), body.trim());
  }

  /** Resolves a review thread of the Session's Merge request, as the user asked from its note on the diff. */
  async resolveReviewThread({ id, thread }: { id: number; thread: string }): Promise<void> {
    const session = this.get(id);
    if (session.status === 'archived') throw new Error('This Session is archived.');
    const { call, forge, workingCopy, number } = this.mergeRequestRead(session);
    await resolveReviewThread(call, forge, workingCopy, number, String(thread));
  }

  /** The Session's linked issue as its Forge has it now, read where `forgeRead` says. */
  async issue({ id }: { id: number }): Promise<IssueDetails> {
    const session = this.get(id);
    if (!session.issue) throw new Error('This Session has no issue.');
    const { call, forge, workingCopy } = this.forgeRead(session);
    return readIssue(call, forge, workingCopy, session.issue.number);
  }

  /** Links the issue `issue` names (its number, `#12`, or its URL) to the Session, once the Forge has it. */
  async linkNamedIssue(id: number, issue: string): Promise<void> {
    const named = issueNamed(issue);
    if (!named) throw new Error('Name an issue by its number, such as 12, or by its URL.');
    const { call, forge, workingCopy } = this.forgeRead(this.get(id));
    const found = await readNamedIssue(call, forge, workingCopy, named);
    if (this.stopped || this.get(id).status === 'archived') return;
    this.options.linkIssue(id, { number: found.number, url: found.url });
  }

  /** Links no more issues: Loom is closing. */
  stop(): void {
    this.stopped = true;
  }

  /** What reading the Session's Merge request takes: where `forgeRead` reads, and its number. */
  private mergeRequestRead(session: Session): ForgeRead & { number: number } {
    if (!session.mergeRequest) throw new Error('This Session has no Merge request.');
    return { ...this.forgeRead(session), number: session.mergeRequest.number };
  }

  /** What reading from the Session's Forge takes: its Environment, its Project's Forge, and where glab runs (its working copy, or the Project's checkout once that is gone). */
  private forgeRead(session: Session): ForgeRead {
    const project = this.options.project(session.projectId);
    if (!project) throw new Error("This Session's Project was removed.");
    const environment = this.options.environment(session);
    if (!environment) throw new Error(`unknown Environment "${project.checkout.environmentId}"`);
    const gone = session.status === 'archived' || session.worktreeMissing;
    return {
      call: environment.request,
      tempDir: () => environment.tempDir(),
      forge: project.forge,
      workingCopy: gone ? project.checkout.path : session.workingCopy.path,
    };
  }

  private get(id: number): Session {
    const session = this.options.session(id);
    if (!session) throw new Error(`unknown Session ${id}`);
    return session;
  }
}
