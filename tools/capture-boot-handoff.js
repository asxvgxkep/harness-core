/* High-frequency real packaged-EXE capture for the Splash -> Desktop handoff. */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXE = path.join(ROOT, "test-app", "DeepSeek Harness.exe");
const label = process.argv[2] || `handoff-${Date.now()}`;
const DEBUG_PORT = Number(process.argv[3]) || 9341;
const OUT = path.join(ROOT, "build", "handoff-captures", label);
const PROFILE = path.join(OUT, "profile");
const APP_LOG = path.join(OUT, "app.log");
const TIMELINE = path.join(OUT, "capture-timeline.json");
const DONE = path.join(OUT, "done.txt");
const CAPTURE_MS = Math.max(1000, Number(process.argv[4]) || 4800);

fs.mkdirSync(path.join(OUT, "splash"), { recursive: true });
fs.mkdirSync(path.join(OUT, "desktop"), { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function instancePids() {
  const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true
  });
  const pids = [];
  for (const line of String(result.stdout || "").split(/\r?\n/u)) {
    const match = /^"DeepSeek Harness\.exe","(\d+)"/u.exec(line.trim());
    if (match !== null) pids.push(Number(match[1]));
  }
  return pids;
}

function treeKill(pid) {
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
}

async function stopOtherInstances() {
  for (const pid of instancePids()) {
    if (pid !== process.pid) treeKill(pid);
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (instancePids().every((pid) => pid === process.pid)) return;
    await sleep(100);
  }
  throw new Error("DeepSeek Harness processes did not exit before capture");
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = null;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP websocket error")), { once: true });
      this.ws.addEventListener("close", () => {
        for (const pending of this.pending.values()) pending.reject(new Error("CDP websocket closed"));
        this.pending.clear();
        this.resolveClosed();
      }, { once: true });
      this.ws.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (pending === undefined) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message || "CDP error"));
          else pending.resolve(message.result);
          return;
        }
        for (const handler of this.handlers.get(message.method) || []) handler(message.params || {});
      });
    });
  }
  on(method, handler) {
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
  }
  send(method, params) {
    if (this.ws === null || this.ws.readyState !== 1) {
      return Promise.reject(new Error("CDP websocket is not open"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function waitForTarget(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
      const hit = targets.find(predicate);
      if (hit !== undefined) return hit;
    } catch {}
    await sleep(20);
  }
  throw new Error("timed out waiting for CDP target");
}

async function recordTarget(kind, target, launchedAt, capture) {
  const dir = path.join(OUT, kind);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  capture.targets[kind] = {
    attachedMs: Date.now() - launchedAt,
    url: target.url,
    frames: [],
    closedMs: null
  };
  let frameIndex = 0;
  let writeChain = Promise.resolve();
  client.on("Page.screencastFrame", (params) => {
    const index = frameIndex++;
    const ext = "png";
    const file = `${String(index).padStart(4, "0")}.${ext}`;
    const frame = {
      index,
      file,
      receivedMs: Date.now() - launchedAt,
      timestamp: params.metadata?.timestamp ?? null,
      deviceWidth: params.metadata?.deviceWidth ?? null,
      deviceHeight: params.metadata?.deviceHeight ?? null
    };
    capture.targets[kind].frames.push(frame);
    writeChain = writeChain.then(() => fs.promises.writeFile(path.join(dir, file), Buffer.from(params.data, "base64")));
    void client.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  });
  await client.send("Page.enable");
  await client.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1
  });
  client.closed.then(() => {
    capture.targets[kind].closedMs = Date.now() - launchedAt;
  });
  return {
    client,
    finish: async () => {
      try {
        await Promise.race([
          client.send("Page.stopScreencast"),
          sleep(250).then(() => { throw new Error("stop screencast timed out"); })
        ]);
      } catch {}
      await writeChain;
      client.close();
    }
  };
}

(async () => {
  await stopOtherInstances();
  const appEnv = { ...process.env };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  const logFd = fs.openSync(APP_LOG, "w");
  const launchedAt = Date.now();
  const child = spawn(EXE, [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: false,
    env: appEnv
  });
  child.unref();

  const capture = {
    label,
    launchedAt: new Date(launchedAt).toISOString(),
    processId: child.pid,
    targets: {}
  };
  const [splashTarget, desktopTarget] = await Promise.all([
    waitForTarget((target) => target.type === "page" && target.url.includes("/splash/splash.html"), 10000),
    waitForTarget((target) => target.type === "page" && target.url.includes("/desktop/desktop.html"), 10000)
  ]);
  const [splashRecorder, desktopRecorder] = await Promise.all([
    recordTarget("splash", splashTarget, launchedAt, capture),
    recordTarget("desktop", desktopTarget, launchedAt, capture)
  ]);

  await sleep(Math.max(0, CAPTURE_MS - (Date.now() - launchedAt)));
  await Promise.all([splashRecorder.finish(), desktopRecorder.finish()]);
  capture.finishedMs = Date.now() - launchedAt;
  fs.writeFileSync(TIMELINE, JSON.stringify(capture, null, 2));
  treeKill(child.pid);
  await sleep(500);
  for (const pid of instancePids()) {
    if (pid !== process.pid) treeKill(pid);
  }
  fs.closeSync(logFd);
  const splashFrames = capture.targets.splash.frames.length;
  const desktopFrames = capture.targets.desktop.frames.length;
  fs.writeFileSync(DONE, `PASS\nsplashFrames=${splashFrames}\ndesktopFrames=${desktopFrames}\n`);
  console.log(JSON.stringify({ out: OUT, splashFrames, desktopFrames, finishedMs: capture.finishedMs }));
})().catch((error) => {
  try { fs.writeFileSync(DONE, `FAIL\n${error.stack || error}\n`); } catch {}
  for (const pid of instancePids()) {
    if (pid !== process.pid) treeKill(pid);
  }
  console.error(error.stack || error);
  process.exitCode = 1;
});
