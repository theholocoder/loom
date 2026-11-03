// A tool's input or output can be huge (a whole file, a long build log). What
// the transcript keeps of it, in the database and in memory, is capped.

/** The most of one tool's input or output kept, in bytes of UTF-8: 256 KB. */
export const TOOL_OUTPUT_CAP = 256 * 1024;

const marker = (bytes: number) => `\n… ${bytes} bytes truncated …\n`;

/**
 * `text` as kept: unchanged at or under `cap` bytes of UTF-8, otherwise its
 * head and its tail around a marker saying how much was cut, all within `cap`.
 * Cuts fall between characters, never inside one.
 */
export function capToolOutput(text: string, cap = TOOL_OUTPUT_CAP): { text: string; truncated: boolean } {
  // A UTF-8 byte count is at most 3 per UTF-16 unit, so short strings need no encoding.
  if (text.length * 3 <= cap) return { text, truncated: false };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= cap) return { text, truncated: false };
  // The marker's count is at most the whole length, so this budget always holds it.
  const room = cap - Buffer.byteLength(marker(bytes.length));
  let headEnd = Math.floor(room / 2);
  let tailStart = bytes.length - (room - headEnd);
  // Continuation bytes (10xxxxxx) are inside a character: move the cuts off them, shrinking what's kept.
  while (headEnd > 0 && (bytes[headEnd]! & 0xc0) === 0x80) headEnd--;
  while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  const head = bytes.subarray(0, headEnd).toString('utf8');
  const tail = bytes.subarray(tailStart).toString('utf8');
  return { text: head + marker(tailStart - headEnd) + tail, truncated: true };
}
