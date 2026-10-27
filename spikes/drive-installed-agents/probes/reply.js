const { resolveShellEnv, which, OpenCodeHost } = require(process.argv[2] + "/agents.js");
const [id, formID] = process.argv.slice(3);
(async () => {
  const env = await resolveShellEnv();
  const host = await new OpenCodeHost().start({ bin: which("opencode", env), env, cwd: "/tmp/loom-spike" });
  let done; const doneP = new Promise((r) => (done = r));
  let text = "";
  host.on("event", (e) => {
    const sid = e.data?.sessionID ?? e.data?.form?.sessionID;
    if (sid !== id) return;
    console.log("ev", e.type);
    if (e.type === "session.text.delta") text += e.data.delta ?? "";
    if (/execution\.(succeeded|failed|interrupted)/.test(e.type)) done(e);
  });
  await host.subscribe();
  const s = await host.api("GET", `/api/session/${id}`);
  console.log("after restart: outcome", s.outcome, "| pending forms", JSON.stringify(await host.api("GET", `/api/session/${id}/form`)).slice(0, 120), "| active", JSON.stringify(await host.api("GET", "/api/session/active")).slice(0, 200));
  for (const body of [{ values: { q0: "Blue" } }, { answers: { q0: "Blue" } }, { q0: "Blue" }]) {
    try { console.log("reply", JSON.stringify(body), "->", JSON.stringify(await host.api("POST", `/api/session/${id}/form/${formID}/reply`, body)).slice(0, 200)); break; }
    catch (e) { console.log("reply", JSON.stringify(body), "failed:", e.message.slice(0, 300)); }
  }
  const t = setTimeout(() => { console.log("no completion in 40s"); host.stop(); process.exit(1); }, 40000);
  const e = await doneP; clearTimeout(t);
  console.log("END", e.type, JSON.stringify(text));
  host.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
