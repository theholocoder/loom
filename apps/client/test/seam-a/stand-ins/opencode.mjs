// A scripted stand-in for the user's `opencode`, put on the Environment's
// PATH by the seam A harness. Usage: node opencode.mjs <script.json> <args...>
// The script says what it reports; every invocation is appended to
// <script.json>.log, one JSON argv per line.
//
// It fakes what Loom's detection uses: `opencode --version`, and
// `opencode serve --stdio`, which prints {"url": ...} on stdout, serves
// `GET /api/integration`, `GET /api/model` (the script's `models`, in
// OpenCode's shape), `GET /api/model/default` (the first of them, 404 with none), `GET /api/command` and `GET /api/skill` (none until
// `/api/model` was asked, as OpenCode loads them with the checkout) behind Basic auth with OPENCODE_SERVER_PASSWORD, and
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
// context tokens, out of the current model's `context`; with `cost`, that
// `usage_update` carries it as the session's cumulative cost (0 until a turn
// gives one). A turn with `tokens` answers its `session/prompt` with them as
// ACP's (unstable) `usage`, cancelled turns included, as OpenCode does. `session/resume` and
// `session/load` take up the session they name (see `refuse`); a load first
// replays its history as `session/update`s, as OpenCode does, and a process
// that took one up plays `resumedTurns`, if given, instead of `turns`. A
// process with every tool denied (a Session highlights check) plays the next
// of `highlightTurns` instead, counted across processes; past their end, an
// answer with nothing to add.
// A `{ notify }` chunk sends that notification as it is, `"$ROOT"` in its
// params standing for the session's id: OpenCode 2.4.2's
// `opencode/session/child_update`, which goes to a client that opted in.
// A turn's `after` chunks play once its `session/prompt` has been answered:
// what a subagent and the run its result starts send with no prompt open.
// `session/load` of a subagent's id (one that a `{ notify }` named as a
// `childSessionId`) is answered without taking it up, and `session/close` of
// it sends its `interrupted` status, as OpenCode 2.4.2 does. A `{ permission }`
// or `{ elicit }` chunk with `from` asks as that subagent, the way OpenCode
// 2.4.2 does (under the session's own id: see asChild); in `after`, its
// answer ends nothing.
// Every message it receives is appended to
// <script.json>.acp.log as {pid, cwd, config, message}, `config` being its
// OPENCODE_CONFIG_CONTENT. It exits when its stdin closes.
//
// Like OpenCode, it keeps each session's usage: a turn adds its `tokens` and
// sets its `cost` in <script.json>.sessions.json, before answering its
// `session/prompt`, and adds its `records` (a Subagent's, or a background
// run's, `"$ROOT"` standing for the session's id) once it has played. With
// `sessionList`, `opencode api --standalone session.list` lists them as
// OpenCode 2.4.2 does: newest change first, paged by `limit` and `cursor`.
// Without it, it fails as an OpenCode without that command would.
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
} else if (args[0] === 'api' && args.includes('session.list') && script.sessionList) {
  listSessions();
} else if (args[0] === 'api' && args.includes('session.message.list') && script.sessionList) {
  listMessages();
} else {
  process.stderr.write(`opencode stand-in: unscripted command ${JSON.stringify(args)}\n`);
  process.exit(1);
}

/** The sessions' usage as OpenCode keeps it, by id. */
function readSessions() {
  const file = `${scriptPath}.sessions.json`;
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

/** Adds a step of session `id` that used `tokens` (ACP's shape), completed now or `at`, and sets the session's cumulative `cost`, if given. */
function recordUsage(id, { parentID, model, tokens, cost, at }) {
  const sessions = readSessions();
  const was = sessions[id] ?? { id, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, steps: [] };
  const step = {
    input: tokens?.inputTokens ?? 0,
    output: tokens?.outputTokens ?? 0,
    reasoning: tokens?.thoughtTokens ?? 0,
    cache: { read: tokens?.cachedReadTokens ?? 0, write: tokens?.cachedWriteTokens ?? 0 },
  };
  const t = was.tokens;
  const now = Math.max(Date.now(), (was.time?.updated ?? 0) + 1);
  const completed = at ?? now;
  const stepCost = cost !== undefined ? Math.max(0, cost - was.cost) : 0;
  sessions[id] = {
    ...was,
    ...(parentID ? { parentID } : {}),
    ...(model ? { model } : {}),
    tokens: { input: t.input + step.input, output: t.output + step.output, reasoning: t.reasoning + step.reasoning, cache: { read: t.cache.read + step.cache.read, write: t.cache.write + step.cache.write } },
    ...(cost !== undefined ? { cost } : {}),
    time: { updated: Math.max(now, completed) },
    steps: [...was.steps, { id: `msg_${String(completed).padStart(15, '0')}_${was.steps.length}`, type: 'assistant', time: { created: completed - 1, completed }, ...(model ? { model } : {}), tokens: step, cost: stepCost }],
  };
  writeFileSync(`${scriptPath}.sessions.json`, JSON.stringify(sessions));
}

/** The `--param key=value`s of an `opencode api` command. */
function apiParams() {
  return Object.fromEntries(args.flatMap((arg, i) => (args[i - 1] === '--param' ? [arg.split('=')] : [])).map(([k, ...v]) => [k, v.join('=')]));
}

/** Prints a page of `items`, as `opencode api` does, its cursor the offset of the next. */
function printPage(items, params) {
  if (params.cursor !== undefined && params.order !== undefined) {
    process.stderr.write('{"_tag":"InvalidCursorError","message":"Cursor cannot be combined with order"}\nHTTP 400 Bad Request\n');
    process.exit(1);
  }
  const limit = Number(params.limit ?? 50);
  const offset = Number(params.cursor ?? 0);
  process.stdout.write(JSON.stringify({ data: items.slice(offset, offset + limit), cursor: { next: String(offset + limit), previous: String(offset) } }, null, 2) + '\n');
}

/** `opencode api --standalone session.list`, as OpenCode 2.4.2 prints it: newest change first. */
function listSessions() {
  const all = Object.values(readSessions()).sort((a, b) => b.time.updated - a.time.updated);
  printPage(
    all.map(({ steps: _steps, ...s }) => ({ projectID: 'global', title: '', location: { directory: s.directory ?? '/home/dev' }, ...s })),
    apiParams(),
  );
}

/** `opencode api --standalone session.message.list --param sessionID=… --param type=assistant`: its steps, newest first. */
function listMessages() {
  const params = apiParams();
  const session = readSessions()[params.sessionID];
  // A step too big to pass on: what's printed is cut off, as the bridge cuts off what it passes on.
  if (session?.tooBig) {
    process.stdout.write('{"data":[{"id":"msg_cut');
    return;
  }
  const steps = [...(session?.steps ?? [])].sort((a, b) => b.time.created - a.time.created);
  printPage(params.order === 'asc' ? steps.reverse() : steps, params);
}

function serve() {
  /** Whether the checkout is loaded, as OpenCode's first `/api/model` does: skills are listed from then on. */
  let loaded = false;
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
    if (req.method === 'GET' && (req.url === '/api/command' || req.url === '/api/skill') && !script.noCatalog) {
      const data = req.url === '/api/command' ? (script.commands ?? []) : loaded ? (script.skills ?? []).map((skill) => ({ path: `/home/dev/.agents/skills/${skill.id}/SKILL.md`, ...skill, content: `# ${skill.name}\n` })) : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data, location }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/model/default') {
      const first = script.models?.[0];
      if (!first) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: apiModel(first), location }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/model') {
      loaded = true;
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
  let resumed = false;
  const turns = () => (resumed && script.acp?.resumedTurns) || script.acp?.turns || [];
  let prompts = 0;
  const checksHighlights = (() => {
    try {
      return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')?.permission?.['*'] === 'deny';
    } catch {
      return false;
    }
  })();
  /** The next of `highlightTurns`, counted in a file beside the script so that each check's process takes its own. */
  const nextHighlightTurn = () => {
    const counter = `${scriptPath}.highlights`;
    const played = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(played + 1));
    return script.acp?.highlightTurns?.[played] ?? { chunks: ['{"add":[],"resolve":[]}'] };
  };
  let sessionId;
  // The model and variant the session runs with, as OpenCode's ACP bridge keeps them.
  const models = (script.models ?? []).filter((m) => m.enabled !== false);
  let selection = { model: models[0], variant: undefined };
  // The turn running, if any: `cancelled` once Loom cancels it, `stopped` resolving then.
  let running;
  /** The session's cumulative cost, as the last turn that gave one said. */
  let cost = 0;
  // Requests this agent sent Loom, waiting on Loom's response.
  let nextRequestId = 1000;
  const responses = new Map();
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = nextRequestId++;
      responses.set(id, resolve);
      send({ id, method, params });
    });
  /** OpenCode's ACP bridge announces its commands once a session is up, with its own `compact`. */
  const announceCommands = () => {
    const availableCommands = [...(script.commands ?? []).map(({ name, description }) => ({ name, description: description ?? '' })), { name: 'compact', description: 'Compact the session' }];
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands } } });
  };
  /** The subagents `{ notify }` chunks named, by id: what their status notifications said of them. */
  const children = new Map();
  const notifyOf = ({ method, params }) => {
    const filled = JSON.parse(JSON.stringify(params).replaceAll('"$ROOT"', JSON.stringify(sessionId)));
    if (method === 'opencode/session/child_update' && filled.childSessionId) children.set(filled.childSessionId, filled);
    send({ method, params: filled });
  };
  /** Plays chunks that send no request of their own: notifications, updates and holds. */
  const play = async (chunks, current) => {
    for (const chunk of chunks) {
      if (current?.cancelled) break;
      if (typeof chunk === 'string') {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } } });
        continue;
      }
      if (chunk.hold) await (current ? Promise.race([released(chunk.hold), current.stopped]) : released(chunk.hold));
      if (current?.cancelled) break;
      if (chunk.notify) notifyOf(chunk.notify);
      if (chunk.update) send({ method: 'session/update', params: { sessionId, update: chunk.update } });
      if (chunk.permission) await askPermission(chunk.permission, chunk.from);
      if (chunk.elicit) await elicit(chunk.elicit, chunk.from);
    }
  };
  /**
   * What a subagent `from` asks, as OpenCode 2.4.2 sends it: under the
   * session's own id, its tool call's id prefixed with the subagent's
   * (`<id>:`), its title with the subagent's (`<title>: `), and the subagent
   * named in its `_meta`.
   */
  const asChild = (toolCall, from) => {
    if (!from) return toolCall;
    const child = children.get(from);
    const prefixed = (title) => (child?.title && title ? `${child.title}: ${title}` : title);
    return {
      ...toolCall,
      ...(toolCall.toolCallId ? { toolCallId: `${from}:${toolCall.toolCallId}` } : {}),
      ...(toolCall.title ? { title: prefixed(toolCall.title) } : {}),
      _meta: { 'opencode/child-session': { id: from, parentID: child?.parentSessionId ?? sessionId, depth: child?.depth ?? 1, ...(child?.title ? { title: child.title } : {}) } },
    };
  };
  /** An elicitation, from the session or, `from`, one of its subagents (as OpenCode 2.4.2 sends it: see asChild). */
  const elicit = (form, from) => {
    if (!from) return ask('elicitation/create', { sessionId, mode: 'form', ...form });
    const title = children.get(from)?.title;
    const { toolCallId, message, ...rest } = form;
    return ask('elicitation/create', { sessionId, mode: 'form', ...rest, ...(toolCallId ? { toolCallId: `${from}:${toolCallId}` } : {}), message: title ? `${title}: ${message}` : message });
  };
  /** OpenCode's permission options. */
  const OPENCODE_OPTIONS = [
    { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
  ];
  /** A permission request, with OpenCode's options or `options`, from the session or, `from`, one of its subagents: resolves with whether it was allowed. */
  const askPermission = async (toolCall, from, options = OPENCODE_OPTIONS) => {
    const reply = await ask('session/request_permission', { sessionId, toolCall: { status: 'pending', ...asChild(toolCall, from) }, options });
    const picked = options.find((o) => o.optionId === reply.result?.outcome?.optionId);
    return picked?.kind.startsWith('allow') ?? false;
  };
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
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} }, ...(script.acp?.images ? { promptCapabilities: { image: true } } : {}) }, authMethods: [] } });
    } else if (method === 'session/new') {
      if (script.acp?.holdNew) await released(script.acp.holdNew);
      sessionId = `ses_standin${process.pid}`;
      send({ id, result: { sessionId, configOptions: configOptions(models, selection) } });
      announceCommands();
    } else if (method === 'session/load' && children.has(params.sessionId)) {
      send({ id, result: { configOptions: configOptions(models, selection) } });
    } else if (method === 'session/close') {
      const child = children.get(params.sessionId);
      if (!child) return send({ id, error: { code: -32602, message: `Invalid params: session not found: ${params.sessionId}` } });
      send({ id, result: {} });
      const { update: _update, error: _error, ...ids } = child;
      notifyOf({ method: 'opencode/session/child_update', params: { ...ids, type: 'status', status: 'interrupted' } });
    } else if (method === 'session/resume' || method === 'session/load') {
      if ((script.acp?.refuse ?? []).includes(method)) return send({ id, error: { code: -32602, message: `Invalid params: session not found: ${params.sessionId}` } });
      sessionId = params.sessionId;
      resumed = true;
      if (method === 'session/load') {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Replayed prompt' } } } });
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replayed reply' } } } });
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'replayed', title: 'Replayed tool', kind: 'read', status: 'completed' } } });
      }
      send({ id, result: { configOptions: configOptions(models, selection) } });
      announceCommands();
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
      const turn = checksHighlights ? nextHighlightTurn() : (turns()[prompts++] ?? { chunks: [] });
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
          if (text.elicit) await elicit(text.elicit, text.from);
          // A permission request, with OpenCode's options; a reject cancels the rest of the turn.
          if (text.permission && !(await askPermission(text.permission, text.from, text.options))) rejected = true;
          if (text.update) send({ method: 'session/update', params: { sessionId, update: text.update } });
          if (text.notify) notifyOf(text.notify);
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
      if (turn.cost !== undefined) cost = turn.cost;
      const model = selection.model ? { providerID: selection.model.providerID, id: selection.model.id } : undefined;
      recordUsage(sessionId, { model, tokens: turn.tokens, ...(turn.cost !== undefined ? { cost } : {}) });
      if ((turn.used || turn.cost !== undefined) && selection.model?.context) {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: turn.used ?? 0, size: selection.model.context, cost: { amount: cost, currency: 'USD' } } } });
      }
      const usage = turn.tokens ? { usage: { totalTokens: Object.values(turn.tokens).reduce((a, b) => a + b, 0), ...turn.tokens } } : {};
      if (rejected || current.cancelled) return send({ id, result: { stopReason: 'cancelled', ...usage } });
      if (turn.error) send({ id, error: { code: -32603, message: turn.error } });
      else send({ id, result: { stopReason: 'end_turn', ...usage } });
      if (turn.after) await play(turn.after);
      for (const record of turn.records ?? []) {
        const id = record.id === '$ROOT' ? sessionId : record.id;
        const parentID = record.parentId === '$ROOT' ? sessionId : record.parentId;
        recordUsage(id, { parentID, model: record.model ?? model, tokens: record.tokens, cost: record.cost });
      }
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
