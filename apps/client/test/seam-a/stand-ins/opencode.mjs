// A scripted stand-in for the user's `opencode`, put on the Environment's
// PATH by the seam A harness. Usage: node opencode.mjs <script.json> <args...>
// The script says what it reports; every invocation is appended to
// <script.json>.log, one JSON argv per line.
//
// It fakes what Loom's detection uses: `opencode --version`, and
// `opencode serve --stdio`, which prints {"url": ...} on stdout, serves
// `GET /api/integration` behind Basic auth with OPENCODE_SERVER_PASSWORD, and
// exits when its stdin closes.
//
// `opencode acp` speaks ACP v1 (newline-delimited JSON-RPC) on its stdio, as
// OpenCode 2.1.4 does: `initialize`, `session/new`, which answers a `ses_…`
// id, and `session/prompt`, which plays the script's `turns` one per prompt
// (see OpencodeScript in harness.ts). Every message it receives is appended to
// <script.json>.acp.log as {pid, cwd, message}. It exits when its stdin closes.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const [scriptPath, ...args] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
appendFileSync(`${scriptPath}.log`, JSON.stringify(args) + '\n');

if (args[0] === '--version') {
  process.stdout.write(`${script.version}\n`);
} else if (args[0] === 'serve' && args.includes('--stdio')) {
  serve();
} else if (args[0] === 'acp') {
  acp();
} else {
  process.stderr.write(`opencode stand-in: unscripted command ${JSON.stringify(args)}\n`);
  process.exit(1);
}

function serve() {
  const expected = 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64');
  const server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/api/integration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: script.integrations ?? [], location: { directory: process.cwd() } }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }) + '\n');
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}

function acp() {
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const turns = script.acp?.turns ?? [];
  let prompts = 0;
  let sessionId;
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    appendFileSync(`${scriptPath}.acp.log`, JSON.stringify({ pid: process.pid, cwd: process.cwd(), message }) + '\n');
    const { id, method, params } = message;
    if (method === 'initialize') {
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    } else if (method === 'session/new') {
      sessionId = `ses_standin${process.pid}`;
      send({ id, result: { sessionId } });
    } else if (method === 'session/prompt') {
      const turn = turns[prompts++] ?? { chunks: [] };
      for (const text of turn.chunks ?? []) {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      }
      if (turn.hold) await released(turn.hold);
      if (turn.error) send({ id, error: { code: -32603, message: turn.error } });
      else send({ id, result: { stopReason: 'end_turn' } });
    } else if (id !== undefined) {
      send({ id, error: { code: -32601, message: `opencode stand-in: unscripted method ${method}` } });
    }
  });
  lines.on('close', () => process.exit(0));
}

/** Resolves once the test releases the hold `name` (see Machine.release). */
function released(name) {
  const file = join(dirname(scriptPath), `release-${name}`);
  return new Promise((resolve) => {
    const check = () => (existsSync(file) ? resolve() : setTimeout(check, 20));
    check();
  });
}
