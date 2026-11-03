// Command-line settings, like the editor and terminal commands, split into
// a program and its arguments.

/**
 * Splits a command line into words as a shell would group them: "…" and '…'
 * quote, and backslashes are kept as they are, for Windows paths. Rejects an
 * unclosed quote.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | undefined;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote) throw new Error(`"${line}" has an unclosed quote`);
  if (inWord) words.push(word);
  return words;
}
