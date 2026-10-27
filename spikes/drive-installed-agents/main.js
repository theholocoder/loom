// Throwaway spike: an Electron main process that finds the user's installed agents, starts one
// Session on each against a test directory and streams events.
//
//   npm start -- --dir <test dir> [--pi-model provider/id] [--oc-model provider/id[:variant]] [--window]
//
// Without --window it prints a JSON report to stdout and quits.
const { app, BrowserWindow } = require("electron");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveShellEnv, PiSession, detectPi, detectOpenCode } = require("./agents");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const dir = path.resolve(arg("dir", process.cwd()));
const piModel = arg("pi-model");
const ocModel = arg("oc-model");
const prompt = arg("prompt", "Read README.md with your read tool and reply with its first line only.");
const loomData = path.join(os.tmpdir(), "loom-spike");
fs.mkdirSync(loomData, { recursive: true });

let win;
const log = (channel, payload) => {
  if (win) win.webContents.send("log", { channel, payload });
};

function countTypes(events) {
  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
  return counts;
}

async function runPi(env, detected) {
  if (!detected.installed) return { skipped: "not installed" };
  if (!detected.signedIn && !piModel) return { skipped: "not signed in: no models reported" };
  const sessionId = randomUUID();
  const s = new PiSession({ bin: detected.bin, env, cwd: dir, sessionId, sessionDir: path.join(loomData, "pi"), model: piModel });
  const events = [];
  let text = "";
  const settled = new Promise((resolve) =>
    s.on("event", (e) => {
      events.push(e);
      log("pi", e);
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") text += e.assistantMessageEvent.delta;
      if (e.type === "agent_settled") resolve();
    }),
  );
  const t0 = Date.now();
  const res = await s.request({ type: "prompt", message: prompt });
  if (!res.success) {
    s.close();
    return { sessionId, promptError: res.error };
  }
  await settled;
  const state = (await s.request({ type: "get_state" })).data;
  const stats = (await s.request({ type: "get_session_stats" })).data;
  s.close();
  return { sessionId, sessionFile: state.sessionFile, model: `${state.model.provider}/${state.model.id}`, ms: Date.now() - t0, text, stats, eventTypes: countTypes(events) };
}

async function runOpenCode(host, detected) {
  if (!detected.signedIn && !ocModel) return { skipped: "not signed in" };
  const events = [];
  let text = "";
  // Loom derives the OpenCode session id from its own Session id.
  const sessionID = `ses_loom${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const done = new Promise((resolve) =>
    host.on("event", (e) => {
      if (e.data?.sessionID !== sessionID) return;
      events.push(e);
      log("opencode", e);
      if (e.type === "session.text.delta") text += e.data.delta ?? "";
      if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)) resolve(e);
    }),
  );
  await host.subscribe();
  const body = { id: sessionID, title: "loom spike", location: { directory: dir } };
  if (ocModel) {
    const [model, variant] = ocModel.split(":");
    const [providerID, id] = model.split("/");
    body.model = { providerID, id, ...(variant && { variant }) };
  }
  const t0 = Date.now();
  await host.api("POST", "/api/session", body);
  await host.api("POST", `/api/session/${sessionID}/prompt`, { text: prompt });
  const end = await done;
  const session = await host.api("GET", `/api/session/${sessionID}`);
  return { sessionID, outcome: end.type, error: end.data.error?.message, ms: Date.now() - t0, text, tokens: session.tokens, cost: session.cost, eventTypes: countTypes(events) };
}

async function main() {
  const t0 = Date.now();
  const env = await resolveShellEnv();
  const shellEnvMs = Date.now() - t0;
  const report = {
    electron: process.versions.electron,
    node: process.versions.node,
    launchPathHasPi: !!require("./agents").which("pi", process.env),
    shellEnvMs,
    shellEnvFailed: !!env.LOOM_SHELL_ENV_FAILED,
  };
  report.pi = await detectPi(env);
  const oc = await detectOpenCode(env, loomData);
  report.opencode = oc.report;
  log("detect", report);
  report.piRun = await runPi(env, report.pi).catch((e) => ({ error: e.message }));
  report.opencodeRun = await runOpenCode(oc.host, report.opencode).catch((e) => ({ error: e.message }));
  oc.host.stop();
  for (const k of ["pi", "opencode"]) report[k].models = `${report[k].models?.length ?? 0} models, e.g. ${JSON.stringify(report[k].models?.slice(0, 2))}`;
  return report;
}

app.whenReady().then(async () => {
  if (process.argv.includes("--window")) {
    win = new BrowserWindow({ width: 1100, height: 800, webPreferences: { preload: path.join(__dirname, "preload.js") } });
    await win.loadFile("index.html");
  }
  try {
    const report = await main();
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    log("report", report);
  } catch (e) {
    process.stderr.write(e.stack + "\n");
    process.exitCode = 1;
  }
  if (!win) app.quit();
});
