import { describe, expect, it } from 'vitest';
import { capToolOutput, TOOL_OUTPUT_CAP } from '../../src/main/sessions/tool-output';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const MARKER = /\n… (\d+) bytes truncated …\n/;

describe('capping a tool output', () => {
  it('is 256 KB of UTF-8', () => {
    expect(TOOL_OUTPUT_CAP).toBe(262144);
  });

  it('keeps an output at or under the cap untouched', () => {
    for (const text of ['', 'ok', 'a'.repeat(TOOL_OUTPUT_CAP), 'é'.repeat(TOOL_OUTPUT_CAP / 2)]) {
      expect(capToolOutput(text)).toEqual({ text, truncated: false });
    }
  });

  it('cuts one byte over the cap, keeping the head and tail around a marker', () => {
    const text = 'H' + 'a'.repeat(TOOL_OUTPUT_CAP - 1) + 'T';
    const { text: kept, truncated } = capToolOutput(text);
    expect(truncated).toBe(true);
    expect(bytes(kept)).toBeLessThanOrEqual(TOOL_OUTPUT_CAP);
    expect(kept.startsWith('Ha')).toBe(true);
    expect(kept.endsWith('aT')).toBe(true);
    const [before, after] = kept.split(MARKER.exec(kept)![0]);
    expect(Number(MARKER.exec(kept)![1])).toBe(bytes(text) - bytes(before!) - bytes(after!));
  });

  it('caps a multi-MB output, saying how much it cut', () => {
    const text = 'HEAD>' + 'x'.repeat(5 * 1024 * 1024) + '<TAIL';
    const { text: kept, truncated } = capToolOutput(text);
    expect(truncated).toBe(true);
    expect(bytes(kept)).toBeLessThanOrEqual(TOOL_OUTPUT_CAP);
    expect(bytes(kept)).toBeGreaterThan(TOOL_OUTPUT_CAP - 8);
    expect(kept.startsWith('HEAD>xxx')).toBe(true);
    expect(kept.endsWith('xxx<TAIL')).toBe(true);
    const [, cut] = MARKER.exec(kept)!;
    expect(bytes(kept) - bytes(MARKER.exec(kept)![0]) + Number(cut)).toBe(bytes(text));
  });

  it('never splits a multi-byte character or a surrogate pair at the cut points', () => {
    for (const char of ['é', '€', '😀']) {
      for (let pad = 0; pad < 4; pad++) {
        const text = 'a'.repeat(pad) + char.repeat(TOOL_OUTPUT_CAP);
        const { text: kept } = capToolOutput(text);
        expect(bytes(kept)).toBeLessThanOrEqual(TOOL_OUTPUT_CAP);
        expect(kept).not.toContain('�');
        const [before, after] = kept.split(MARKER.exec(kept)![0]);
        expect(before).toBe('a'.repeat(pad) + char.repeat((before!.length - pad) / char.length));
        expect(after).toBe(char.repeat(after!.length / char.length));
      }
    }
  });
});
