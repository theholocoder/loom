const { resolveShellEnv, which, OpenCodeHost } = require(process.argv[2] + "/agents.js");
const [dirA, dirB] = process.argv.slice(3);
const model = { providerID: "openai", id: "gpt-6-luna-fast", variant: "low" };
(async () => {
  const env = await resolveShellEnv();
  const host = await new OpenCodeHost().start({ bin: which("opencode", env), env, cwd: "/tmp/loom-spike" });
  const log = { A: [], B: [], Q: [] };
  const ids = { A: "ses_loomconcA" + Date.now(), B: "ses_loomconcB" + Date.now(), Q: "ses_loomquest" + Date.now() };
  const waiters = {};
  host.on("event", (e) => {
    for (const k of Object.keys(ids)) if (e.data?.sessionID === ids[k]) {
      log[k].push(e.type + (e.type === "session.execution.interrupted" ? `(${e.data.reason})` : ""));
      waiters[k]?.(e);
    }
  });
  await host.subscribe();
  const until = (k, re) => new Promise((r) => (waiters[k] = (e) => re.test(e.type) && r(e)));
  for (const [k, dir] of [["A", dirA], ["B", dirB], ["Q", dirA]]) await host.api("POST", "/api/session", { id: ids[k], location: { directory: dir }, model });
  const active0 = await host.api("GET", "/api/session/active");
  const doneA = until("A", /execution\.(succeeded|failed)/);
  const startB = until("B", /tool\.called|text\.started/);
  await host.api("POST", `/api/session/${ids.A}/prompt`, { text: "Run `pwd` with bash and reply with its output only." });
  await host.api("POST", `/api/session/${ids.B}/prompt`, { text: "Run `sleep 30 && pwd` with bash, then reply with the output." });
  console.error("prompted A and B"); await startB; console.error("B started");
  const active = await host.api("GET", "/api/session/active");
  const endB = until("B", /execution\.(succeeded|failed|interrupted)/);
  await host.api("POST", `/api/session/${ids.B}/interrupt`, {});
  const b = await endB; console.error("B ended"); const a = await doneA; console.error("A ended");
  // Question tool -> form
  const form = until("Q", /^form\.created$/);
  await host.api("POST", `/api/session/${ids.Q}/prompt`, { text: "Use your question tool to ask me which color I prefer: red or blue. Then reply with my answer only." });
  const f = await form;
  const forms = await host.api("GET", `/api/session/${ids.Q}/form`);
  const doneQ = until("Q", /execution\.(succeeded|failed)/);
  console.log("form.created payload:", JSON.stringify(f.data).slice(0, 700));
  console.log("pending forms:", JSON.stringify(forms).slice(0, 300));
  globalThis.__q = { f, forms, doneQ, host, ids, log, active0, active, a, b };
  const fs = require("fs"); fs.writeFileSync("/tmp/loom-spike/q.json", JSON.stringify({ form: f.data }));
  setTimeout(() => { console.log("log:", JSON.stringify(log, null, 1)); host.stop(); process.exit(0); }, 200);
})().catch((e) => { console.error(e); process.exit(1); });
