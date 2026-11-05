// A scripted stand-in for the user's `opencode`, put on the Environment's
// PATH by the seam A harness. Usage: node opencode.mjs <script.json> <args...>
// The script says what it reports; every invocation is appended to
// <script.json>.log, one JSON argv per line.
//
// It fakes what Loom's detection uses: `opencode --version`, and
// `opencode serve --stdio`, which prints {"url": ...} on stdout, serves
// `GET /api/integration` and `GET /api/model` (the script's `models`, in
// OpenCode's shape) behind Basic auth with OPENCODE_SERVER_PASSWORD, and
// exits when its stdin closes. Each request is appended to
// <script.json>.http.log as {method, path, directory}, `directory` being its
// x-opencode-directory header.
//
// `opencode acp` speaks ACP v1 (newline-delimited JSON-RPC) on its stdio, as
// OpenCode 2.1.4 does: `initialize` (taking images in prompts with `images`), `session/new`, which answers a `ses_…`
// id and the `model` and `effort` config options (the script's `models`, the
// first one current), `session/set_config_option`, which answers them as
// changed (a new model goes back to the default Effort; with `holdConfig`,
// only once the test releases it), and `session/prompt`, which plays the script's `turns` one per prompt
// (see OpencodeScript in harness.ts); an `elicit` chunk sends Loom an
// `elicitation/create` request and waits for its response, a `permission`
// chunk a `session/request_permission` one (a reject ends the turn as
// cancelled, as OpenCode does). A `session/cancel` notification ends the
// running turn as cancelled, cutting short what it holds on; a
// `session/prompt` while a turn runs is refused, as OpenCode 2.1.4's ACP
// bridge does. A turn with `used` ends with a `usage_update` of that many
// context tokens, out of the current model's `context`. Every message it receives is appended to
// <script.json>.acp.log as {pid, cwd, config, message}, `config` being its
// OPENCODE_CONFIG_CONTENT. It exits when its stdin closes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
    const directory = req.headers['x-opencode-directory'];
    appendFileSync(`${scriptPath}.http.log`, JSON.stringify({ method: req.method, path: req.url, ...(directory ? { directory } : {}) }) + '\n');
    const location = { directory: directory ?? process.cwd() };
    if (req.method === 'GET' && req.url === '/api/integration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: script.integrations ?? [], location }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/model') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: (script.models ?? []).map(apiModel), location }));
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

/** A script model as OpenCode 2.2.5's `GET /api/model` lists it (the fields Loom reads, and some it doesn't). */
function apiModel({ providerID, id, name, variants = [], context, enabled = true }) {
  return {
    id,
    modelID: id,
    providerID,
    type: 'chat',
    name,
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: variants.map((variant) => ({ id: variant, settings: { reasoningEffort: variant } })),
    status: 'active',
    enabled,
    ...(context ? { limit: { context, output: 32000 } } : {}),
  };
}

function acp() {
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const turns = script.acp?.turns ?? [];
  let prompts = 0;
  let sessionId;
  // The model and variant the session runs with, as OpenCode's ACP bridge keeps them.
  const models = (script.models ?? []).filter((m) => m.enabled !== false);
  let selection = { model: models[0], variant: undefined };
  // The turn running, if any: `cancelled` once Loom cancels it, `stopped` resolving then.
  let running;
  // Requests this agent sent Loom, waiting on Loom's response.
  let nextRequestId = 1000;
  const responses = new Map();
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = nextRequestId++;
      responses.set(id, resolve);
      send({ id, method, params });
    });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    appendFileSync(`${scriptPath}.acp.log`, JSON.stringify({ pid: process.pid, cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT, message }) + '\n');
    const { id, method, params } = message;
    if (method === undefined && responses.has(id)) {
      const resolve = responses.get(id);
      responses.delete(id);
      resolve(message);
      return;
    }
    if (method === 'initialize') {
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, ...(script.acp?.images ? { promptCapabilities: { image: true } } : {}) }, authMethods: [] } });
    } else if (method === 'session/new') {
      if (script.acp?.holdNew) await released(script.acp.holdNew);
      sessionId = `ses_standin${process.pid}`;
      send({ id, result: { sessionId, configOptions: configOptions(models, selection) } });
    } else if (method === 'session/set_config_option') {
      if (script.acp?.holdConfig) await released(script.acp.holdConfig);
      const { configId, value } = params;
      if (configId === 'model') {
        const model = models.find((m) => `${m.providerID}/${m.id}` === value);
        if (!model) return send({ id, error: { code: -32602, message: `Invalid model: ${value}` } });
        selection = { model, variant: model === selection.model ? selection.variant : undefined };
      } else if (configId === 'effort') {
        if (value !== 'default' && !(selection.model?.variants ?? []).includes(value)) return send({ id, error: { code: -32602, message: `Invalid effort: ${value}` } });
        selection = { ...selection, variant: value };
      } else {
        return send({ id, error: { code: -32602, message: `Invalid config option: ${configId}` } });
      }
      send({ id, result: { configOptions: configOptions(models, selection) } });
    } else if (method === 'session/cancel') {
      if (running) {
        running.cancelled = true;
        running.stop();
      }
    } else if (method === 'session/prompt') {
      if (running) return send({ id, error: { code: -32603, message: 'session is busy' } });
      const turn = turns[prompts++] ?? { chunks: [] };
      const current = { cancelled: false };
      current.stopped = new Promise((resolve) => (current.stop = resolve));
      running = current;
      const hold = (name) => Promise.race([released(name), current.stopped]);
      let rejected = false;
      for (const text of turn.chunks ?? []) {
        if (rejected || current.cancelled) break;
        if (typeof text === 'object') {
          if (text.hold) await hold(text.hold);
          if (current.cancelled) break;
          // An elicitation (a question, or a plugin's form): the turn goes on once Loom answers it.
          if (text.elicit) await ask('elicitation/create', { sessionId, mode: 'form', ...text.elicit });
          // A permission request, with OpenCode's options; a reject cancels the rest of the turn.
          if (text.permission) {
            const reply = await ask('session/request_permission', {
              sessionId,
              toolCall: { status: 'pending', ...text.permission },
              options: [
                { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
                { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
                { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
              ],
            });
            if (reply.result?.outcome?.optionId !== 'once') rejected = true;
          }
          if (text.update) send({ method: 'session/update', params: { sessionId, update: text.update } });
          // A tool output of `bytes` bytes, made here so the script stays small: HEAD>, x's, <TAIL.
          if (text.bigOutput) {
            const { toolCallId, bytes } = text.bigOutput;
            const output = 'HEAD>' + 'x'.repeat(bytes - 10) + '<TAIL';
            send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] } } });
          }
          continue;
        }
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      }
      if (!rejected && !current.cancelled && turn.hold) await hold(turn.hold);
      running = undefined;
      if (turn.used && selection.model?.context) {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: turn.used, size: selection.model.context, cost: { amount: 0, currency: 'USD' } } } });
      }
      if (rejected || current.cancelled) return send({ id, result: { stopReason: 'cancelled' } });
      if (turn.error) send({ id, error: { code: -32603, message: turn.error } });
      else send({ id, result: { stopReason: 'end_turn' } });
    } else if (id !== undefined) {
      send({ id, error: { code: -32601, message: `opencode stand-in: unscripted method ${method}` } });
    }
  });
  lines.on('close', () => {
    // An agent that writes in its last moment, as Loom stops it.
    if (script.acp?.writeOnExit) writeFileSync(join(process.cwd(), script.acp.writeOnExit), 'written on the way out\n');
    process.exit(0);
  });
}

/** The config options OpenCode 2.1.4's ACP bridge reports, for the models it offers and the selection. */
function configOptions(models, { model, variant }) {
  const variants = model?.variants ?? [];
  const title = (id) => id.split(/[_-]/).map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part)).join(' ');
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: model ? `${model.providerID}/${model.id}` : '',
      options: models.map((m) => ({ value: `${m.providerID}/${m.id}`, name: `${m.providerID}/${m.name}` })),
    },
    ...(variants.length
      ? [
          {
            id: 'effort',
            name: 'Effort',
            description: 'Available effort levels for this model',
            category: 'thought_level',
            type: 'select',
            currentValue: variant && variants.includes(variant) ? variant : 'default',
            options: [...new Set([...variants, 'default'])].map((value) => ({ value, name: title(value) })),
          },
        ]
      : []),
    { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'build' }, { value: 'plan', name: 'plan' }] },
  ];
}

/** Resolves once the test releases the hold `name` (see Machine.release). */
function released(name) {
  const file = join(dirname(scriptPath), `release-${name}`);
  return new Promise((resolve) => {
    const check = () => (existsSync(file) ? resolve() : setTimeout(check, 20));
    check();
  });
}
