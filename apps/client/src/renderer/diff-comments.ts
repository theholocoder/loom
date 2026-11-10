// What a range picked in a file's diff quotes of it: the lines between its
// ends in the order the patch has them, whichever end was picked first and
// whichever side (old or new) each end is on, and the lines it spans in one
// file's numbering.
import type { DiffComment } from '../shared/api';

/** A side of a diff: the old file's (removed lines) or the new file's. */
export type Side = 'deletions' | 'additions';

/** One end of a range, as the diff library reports it: a line number on the old (deletions) or new (additions) side. */
export interface LinePoint {
  lineNumber: number;
  side?: Side;
}

/** A range picked in the diff, as the diff library reports it. */
export interface LineRange {
  start: number;
  side?: Side;
  end: number;
  endSide?: Side;
}

/** A range's quote: what a comment on it holds but the note, and its last line, where the note goes. */
export type Quote = Omit<DiffComment, 'note'> & { last: Required<LinePoint> };

interface Row {
  text: string;
  old?: number;
  new?: number;
}

/** The lines of a one-file patch's hunks, numbered on each side they're on. */
function hunkRows(patch: string): Row[] {
  const out: Row[] = [];
  let old = 0;
  let current = 0;
  let inHunk = false;
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      old = Number(hunk[1]);
      current = Number(hunk[2]);
      inHunk = true;
    } else if (!inHunk || text === '' || text.startsWith('\\')) {
      // Headers before the first hunk, the patch's last newline, and "\ No newline at end of file".
    } else if (text.startsWith('-')) out.push({ text, old: old++ });
    else if (text.startsWith('+')) out.push({ text, new: current++ });
    else out.push({ text, old: old++, new: current++ });
  }
  return out;
}

/** Where a point is among the rows: a removed line by its old number, another line by its new one. */
function rowIndex(rows: Row[], { lineNumber, side }: LinePoint): number {
  return side === 'deletions' ? rows.findIndex((r) => r.old === lineNumber) : rows.findIndex((r) => r.new === lineNumber);
}

/** A row's number on the side it is drawn on: its old one for a removed line, its new one otherwise. */
const numberOf = (row: Row) => row.new ?? row.old!;
const sideOf = (row: Row): Side => (row.new === undefined ? 'deletions' : 'additions');

/** What `range` quotes of `patch`, the diff of the file at `path`; nothing when either end isn't in it. */
export function quoteRange(path: string, patch: string, range: LineRange): Quote | undefined {
  const rows = hunkRows(patch);
  const startAt = rowIndex(rows, { lineNumber: range.start, side: range.side });
  const endAt = rowIndex(rows, { lineNumber: range.end, side: range.endSide ?? range.side });
  if (startAt < 0 || endAt < 0) return undefined;
  const [top, bottom] = [Math.min(startAt, endAt), Math.max(startAt, endAt)];
  const quoted = rows.slice(top, bottom + 1);
  const last = quoted.at(-1)!;
  // One numbering for the whole range, as the two may have drifted apart: the new file's for a
  // range holding any line of it, the old file's only for a range of removed lines alone.
  const numbers = quoted.some((r) => r.new !== undefined) ? quoted.flatMap((r) => (r.new === undefined ? [] : [r.new])) : quoted.map((r) => r.old!);
  return {
    path,
    start: numbers[0]!,
    end: numbers.at(-1)!,
    lines: quoted.map((r) => r.text),
    last: { lineNumber: numberOf(last), side: sideOf(last) },
  };
}
