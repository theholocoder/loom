window.spike.onLog(({ channel, payload }) => {
  const targets = channel === "pi" || channel === "opencode" ? [channel] : ["pi", "opencode"];
  for (const t of targets) {
    const el = document.createElement("div");
    el.className = "e";
    el.textContent = `${channel}: ${JSON.stringify(payload).slice(0, 400)}`;
    document.getElementById(t).append(el);
  }
});
