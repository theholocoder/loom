// The one message that tells the agent about feedback on its Merge request.
import { codePlace, type FeedbackItem, type TranscriptItem } from '../../shared/api';

/** What is sent for a feedback card, by the user's Send to agent or, later, by auto-prompt. */
export function feedbackPrompt({ url, items }: Pick<Extract<TranscriptItem, { kind: 'feedback' }>, 'url' | 'items'>): string {
  const lines = items.flatMap((item, at) => linesOf(item, at + 1));
  return [`There is new feedback on this Session's Merge request (${url}):`, '', ...lines, '', 'Fix what needs fixing, push the branch, and reply on the Merge request to what needs a reply.'].join('\n');
}

function linesOf(item: FeedbackItem, n: number): string[] {
  switch (item.kind) {
    case 'review': {
      const verdict = item.verdict === 'changes-requested' ? 'requested changes' : 'commented';
      const said = item.excerpt ? `: "${item.excerpt}"` : '';
      return [`${n}. Review by ${item.author}, who ${verdict}${said} (${item.url})`, ...item.comments.map((c) => `   - ${codePlace(c)}: "${c.excerpt}" (${c.url})`)];
    }
    case 'comment':
      return [`${n}. Comment by ${item.author}${item.path ? ` on ${codePlace(item)}` : ''}: "${item.excerpt}" (${item.url})`];
    case 'ci-failed':
      return [`${n}. CI failed:`, ...item.checks.map((check) => `   - ${check.name}${check.url ? ` (${check.url})` : ''}`)];
    case 'conflicts':
      return [`${n}. The Merge request has conflicts with its target branch.`];
  }
}
