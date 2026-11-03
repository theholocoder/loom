// A stub for the user's editor or terminal, put on the Environment's PATH by
// the seam A harness. Usage: node editor.mjs <script.json> <args...>
// Every invocation is appended to <script.json>.log, one JSON line with its args and the
// folder it ran in, then it exits, as an editor's launcher does.
import { appendFileSync } from 'node:fs';

const [scriptPath, ...args] = process.argv.slice(2);
const cwd = process.platform === 'win32' ? process.cwd().replaceAll('\\', '/') : process.cwd();
appendFileSync(`${scriptPath}.log`, JSON.stringify({ args, cwd }) + '\n');
