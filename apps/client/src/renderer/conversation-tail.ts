import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { TranscriptItem } from '../shared/api';

export const TURNS_PER_PAGE = 10;

export interface ConversationTail {
  shown: TranscriptItem[];
  hasEarlier: boolean;
  showEarlier: () => void;
  showTurn: (itemId: number) => void;
  followFoot: () => void;
}

export function useConversationTail(items: TranscriptItem[], conversation: RefObject<HTMLElement | null>): ConversationTail {
  const [from, setFrom] = useState<number>();
  const afterShowing = useRef<() => void>(undefined);
  useLayoutEffect(() => {
    afterShowing.current?.();
    afterShowing.current = undefined;
  }, [from]);

  const starts = turnStarts(items);
  const firstShownAt =
    from !== undefined ? Math.max(items.findIndex((item) => item.id >= from), 0) : starts.length > TURNS_PER_PAGE ? starts.at(-TURNS_PER_PAGE)! : 0;
  const shown = items.slice(firstShownAt);
  const messages = () => [...(conversation.current?.querySelectorAll<HTMLElement>('[data-item-id]') ?? [])];
  const scrollToTurn = (itemId: number) => {
    const all = messages();
    const target = all.filter((m) => Number(m.dataset.itemId) <= itemId).at(-1) ?? all[0];
    target?.scrollIntoView?.({ block: 'start' });
  };
  const showFrom = (at: number, then: () => void) => {
    afterShowing.current = then;
    setFrom(items[at]!.id);
  };

  return {
    shown,
    hasEarlier: shown.length < items.length,
    showEarlier: () => {
      const earlierStarts = starts.filter((at) => at < firstShownAt);
      const reading = messages()[0];
      const top = reading?.getBoundingClientRect().top;
      showFrom(earlierStarts.at(-TURNS_PER_PAGE) ?? 0, () => {
        const chat = conversation.current;
        if (chat && reading && top !== undefined) chat.scrollTop += reading.getBoundingClientRect().top - top;
      });
    },
    showTurn: (itemId) => {
      const turnAt = starts.findLast((at) => items[at]!.id <= itemId) ?? 0;
      if (turnAt >= firstShownAt) scrollToTurn(itemId);
      else showFrom(turnAt, () => scrollToTurn(itemId));
    },
    followFoot: () => setFrom(undefined),
  };
}

function turnStarts(items: TranscriptItem[]): number[] {
  return items.flatMap((item, at) => (item.kind === 'user' ? [at] : []));
}
