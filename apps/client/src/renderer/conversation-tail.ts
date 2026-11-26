import type { TranscriptItem } from '../shared/api';

export const TURNS_SHOWN = 10;

export function lastTurns(items: TranscriptItem[], turns: number): { shown: TranscriptItem[]; hasEarlier: boolean } {
  const starts = turnStarts(items);
  if (starts.length <= turns) return { shown: items, hasEarlier: false };
  return { shown: items.slice(starts[starts.length - turns]), hasEarlier: true };
}

export function turnsReaching(items: TranscriptItem[], itemId: number): number {
  const starts = turnStarts(items);
  const reached = starts.findLastIndex((at) => items[at]!.id <= itemId);
  return starts.length - Math.max(reached, 0);
}

function turnStarts(items: TranscriptItem[]): number[] {
  return items.flatMap((item, at) => (item.kind === 'user' ? [at] : []));
}
