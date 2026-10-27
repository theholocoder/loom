// Throwaway spike: drive the user's installed `pi` and `opencode` from Electron's main process.
// See https://github.com/theholocoder/loom/issues/24
const { spawn, execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

// A desktop-launched Electron app does not inherit the shell PATH (mise, nvm, ~/.local/bin...).
// Ask the user's interactive login shell for its environment, like VS Code does.
function resolveShellEnv(timeoutMs = 5000) {
  if (process.platform === "win32") return Promise.resolve({ ...process.env });
  const shell = process.env.SHELL || "/bin/bash";
  const mark = "__LOOM_ENV__";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '${mark}'; env -0; printf '${mark}'`],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        const body = (stdout || "").split(mark)[1];
        if (err || !body) return resolve({ ...process.env, LOOM_SHELL_ENV_FAILED: "1" });
        const env = {};
        for (const entry of body.split("\0")) {
          const i = entry.indexOf("=");
          if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
        }
        resolve(env);
      },
    );
  });
}

function which(name, env) {
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function run(bin, args, env, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout.trim(), stderr: stderr.trim(), err: err && err.message }),
    );
  });
}

// Split on LF only: readline would also split on U+2028/U+2029, which are valid inside JSON strings.
function onJsonLines(stream, cb) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line) cb(JSON.parse(line));
    }
  });
}

// ---------------------------------------------------------------- Pi

// One `pi --mode rpc` child per Session: a process hosts one active session, starts in ~0.4 s,
// and its cwd scopes tools and AGENTS.md discovery.
class PiSession extends EventEmitter {
  constructor({ bin, env, cwd, sessionId, sessionDir, model }) {
    super();
    const args = ["--mode", "rpc"];
    if (sessionId) args.push("--session-id", sessionId, "--session-dir", sessionDir);
    else args.push("--no-session");
    if (model) args.push("--model", model);
    this.proc = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.proc.stderr.on("data", (d) => (this.stderr += d));
    this.proc.on("exit", (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new Error(`pi exited (${code ?? signal})`));
      this.emit("exit", { code, signal });
    });
    onJsonLines(this.proc.stdout, (rec) => {
      if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
        const { resolve } = this.pending.get(rec.id);
        this.pending.delete(rec.id);
        resolve(rec);
      } else {
        this.emit("event", rec);
      }
    });
  }

  request(cmd) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  }

  // Closing stdin asks Pi for an orderly shutdown.
  close() {
    this.proc.stdin.end();
  }
}

async function detectPi(env) {
  const bin = which("pi", env);
  if (!bin) return { installed: false };
  const version = (await run(bin, ["--version"], env)).stdout;
  // Signed in = the agent reports at least one usable model. `pi auth check` needs a provider name.
  const probe = new PiSession({ bin, env, cwd: env.HOME });
  const models = (await probe.request({ type: "get_available_models" })).data.models;
  probe.close();
  return {
    installed: true,
    bin,
    version,
    signedIn: models.length > 0,
    models: models.map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name, reasoning: m.reasoning })),
  };
}

// ---------------------------------------------------------------- OpenCode

// One `opencode serve` per Client, private to Loom (not the user's background service):
// random port, Loom-chosen password, many Sessions in many worktree directories.
class OpenCodeHost extends EventEmitter {
  async start({ bin, env, cwd }) {
    this.password = randomBytes(24).toString("base64url");
    // --stdio: prints {"url"} on stdout and exits when stdin closes, so the server dies with Loom
    // even on a crash. Plain `serve` survives its parent, including a normal app.quit().
    this.proc = spawn(bin, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd,
      env: { ...env, OPENCODE_SERVER_PASSWORD: this.password },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("exit", (code, signal) => this.emit("exit", { code, signal }));
    this.url = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`opencode serve did not start: ${out}`)), 15000);
      this.proc.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/"url":"(http:\/\/[^"]+)"/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      this.proc.on("exit", () => reject(new Error(`opencode serve exited: ${out}`)));
    });
    this.auth = "Basic " + Buffer.from(`opencode:${this.password}`).toString("base64");
    return this;
  }

  async api(method, p, body) {
    const res = await fetch(this.url + p, {
      method,
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${raw}`);
    // Replies (e.g. form reply) answer with an empty body.
    if (!raw) return null;
    const json = JSON.parse(raw);
    // Most routes wrap results in { data }; /api/info does not.
    return "data" in json ? json.data : json;
  }

  // The single global SSE feed (all directories, live only); callers filter by sessionID.
  async subscribe() {
    this.abort = new AbortController();
    const res = await fetch(this.url + "/api/event", {
      headers: { authorization: this.auth },
      signal: this.abort.signal,
    });
    const decoder = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (data) this.emit("event", JSON.parse(data));
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") this.emit("error", e);
      }
    })();
  }

  stop() {
    this.abort?.abort();
    this.proc?.stdin.end();
  }
}

async function detectOpenCode(env, cwd) {
  const bin = which("opencode", env);
  if (!bin) return { installed: false };
  const version = (await run(bin, ["--version"], env)).stdout;
  const host = await new OpenCodeHost().start({ bin, env, cwd });
  const info = await host.api("GET", "/api/info");
  const integrations = await host.api("GET", "/api/integration");
  const models = await host.api("GET", "/api/model");
  const connected = integrations.filter((i) => i.connections.length > 0).map((i) => i.id);
  return {
    host,
    report: {
      installed: true,
      bin,
      version,
      serverVersion: info.version,
      // Free OpenCode Zen models are listed even with no credential, so "signed in" = a connected integration.
      signedIn: connected.length > 0,
      connectedIntegrations: connected,
      models: models.map((m) => ({
        id: `${m.providerID}/${m.id}`,
        name: m.name,
        variants: (m.variants || []).map((v) => v.id),
      })),
    },
  };
}

module.exports = { resolveShellEnv, which, PiSession, detectPi, OpenCodeHost, detectOpenCode };
