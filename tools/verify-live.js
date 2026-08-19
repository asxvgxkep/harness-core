// Live integration probe for the desktop backend (not a unit test):
//  1. queryGpu() / detectWsl() against the real machine tools;
//  2. createDesktopHostProxy against the real loopback Host — session.create,
//     session.prompt and the events.mux SSE stream end to end.
// Run under node or Electron-as-node with full system access.
const { pathToFileURL } = require("url");
const path = require("path");

(async () => {
  const system = await import(pathToFileURL(path.join(__dirname, "..", "src", "lib", "types", "desktop-system.js")).href);
  const host = await import(pathToFileURL(path.join(__dirname, "..", "src", "lib", "types", "desktop-host.js")).href);

  console.log("[gpu] probing nvidia-smi...");
  const gpu = await system.queryGpu();
  console.log("[gpu] " + JSON.stringify(gpu));

  console.log("[wsl] probing wsl.exe...");
  const wsl = await system.detectWsl();
  console.log("[wsl] " + JSON.stringify(wsl));

  const origin = process.env.DSH_LIVE_ORIGIN || "http://127.0.0.1:60454";
  console.log("[host] probing " + origin + " ...");
  const frames = [];
  const proxy = host.createDesktopHostProxy({ origin, forwardEvent: (frame) => frames.push(frame) });

  const created = await proxy.call("session.create", {});
  if (!created.ok) {
    console.log("[host] session.create FAILED: " + JSON.stringify(created.error));
    process.exit(2);
  }
  const sessionId = created.value.sessionId;
  console.log("[host] session created: " + sessionId);

  proxy.events.start();
  const prompted = await proxy.call("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: "Reply with exactly: DESKTOP-HARNESS-LINK-OK" }]
  });
  if (!prompted.ok) {
    console.log("[host] session.prompt FAILED: " + JSON.stringify(prompted.error));
    proxy.close();
    process.exit(2);
  }
  console.log("[host] prompt queued, listening to events.mux...");

  const deadline = Date.now() + 180000;
  let text = "";
  let ended = false;
  while (Date.now() < deadline && !ended) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    while (frames.length > 0) {
      const frame = frames.shift();
      if (frame.type === "stream/error") {
        console.log("[host] stream error: " + JSON.stringify(frame.error));
        ended = true;
        break;
      }
      if (frame.type === "session/event" && frame.sessionId === sessionId) {
        const event = frame.event;
        if (event.type === "assistant/chunk" && event.data?.chunk?.type === "text-delta") {
          text += event.data.chunk.text;
        } else if (event.type === "turn/end") {
          ended = true;
          break;
        } else if (event.type === "tool/result") {
          console.log("[host] tool result: " + (event.data?.message?.toolName || "?"));
        }
      }
    }
  }

  console.log("[host] assistant text: " + JSON.stringify(text));
  proxy.close();
  const ok = text.includes("DESKTOP-HARNESS-LINK-OK");
  console.log(ok ? "LIVE LINK OK" : "LIVE LINK MISMATCH");
  process.exit(ok ? 0 : 3);
})().catch((error) => {
  console.error("probe crashed:", error);
  process.exit(2);
});
