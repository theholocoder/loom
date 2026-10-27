const { resolveShellEnv, which, OpenCodeHost } = require(process.argv[2] + "/agents.js");
(async () => {
  const env = await resolveShellEnv();
  const host = await new OpenCodeHost().start({ bin: which("opencode", env), env, cwd: "/tmp/loom-spike" });
  const id = "ses_loomquest" + Date.now();
  let resolveForm, resolveDone, text = "";
  const formP = new Promise((r) => (resolveForm = r)), doneP = new Promise((r) => (resolveDone = r));
  host.on("event", (e) => {
    const sid = e.data?.sessionID ?? e.data?.form?.sessionID;
    if (sid !== id) return;
    if (/^form\./.test(e.type)) console.log("ev", e.type);
    if (e.type === "form.created") resolveForm(e);
    if (e.type === "session.text.delta") text += e.data.delta ?? "";
    if (/execution\.(succeeded|failed|interrupted)/.test(e.type)) resolveDone(e);
  });
  await host.subscribe();
  await host.api("POST", "/api/session", { id, location: { directory: process.argv[3] }, model: { providerID: "openai", id: "gpt-6-luna-fast", variant: "low" } });
  await host.api("POST", `/api/session/${id}/prompt`, { text: "Use your question tool to ask me which color I prefer: red or blue. Then reply with my answer only." });
  const f = await formP;
  for (const answer of [{ q0: "Blue" }, [{ key: "q0", value: "Blue" }], "Blue"]) {
    try { console.log("reply", JSON.stringify({ answer }), "->", JSON.stringify(await host.api("POST", `/api/session/${id}/form/${f.data.form.id}/reply`, { answer })).slice(0, 200)); break; }
    catch (e) { console.log("reply", JSON.stringify({ answer }), "failed:", e.message.slice(-200)); }
  }
  const t = setTimeout(() => { console.log("no completion"); host.stop(); process.exit(1); }, 40000);
  const end = await doneP; clearTimeout(t);
  console.log("END", end.type, JSON.stringify(text));
  host.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
