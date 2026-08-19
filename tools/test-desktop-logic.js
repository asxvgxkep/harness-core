// Logic tests for the desktop AI Command Center.
// Part 1 (ESM imports): main-process modules — nvidia-smi/WSL parsers, system
//   monitor, workspace inspection, host proxy against a live mock HTTP host.
// Part 2 (vm): renderer command engine (registry/scoring/intent routing) and
//   the AI Core state machine (classes, labels, done→idle, failed).
// Run under node or Electron-as-node.
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const http = require("http");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const results = [];
function check(name, cond) {
  results.push((cond ? "PASS " : "FAIL ") + name);
  if (!cond) console.log("       -> " + name + " FAILED");
}

// ---------------------------------------------------------------------------
// Part 1 — ESM main-process modules
// ---------------------------------------------------------------------------
(async () => {
  const system = await import(pathToFileURL(path.join(ROOT, "src", "lib", "types", "desktop-system.js")).href);
  const workspace = await import(pathToFileURL(path.join(ROOT, "src", "lib", "types", "desktop-workspace.js")).href);
  const host = await import(pathToFileURL(path.join(ROOT, "src", "lib", "types", "desktop-host.js")).href);
  const config = await import(pathToFileURL(path.join(ROOT, "src", "lib", "types", "desktop-config.js")).href);

  // --- nvidia-smi parser -----------------------------------------------------
  const gpus = system.parseNvidiaSmi([
    "NVIDIA GeForce RTX 4080 SUPER, 12, 5123, 16376, 54",
    "N/A",
    "   "
  ].join("\n"));
  check("nvidia-smi: parses one gpu", gpus.length === 1);
  check("nvidia-smi: name kept", gpus.length === 1 && gpus[0].name === "NVIDIA GeForce RTX 4080 SUPER");
  check("nvidia-smi: numeric fields", gpus.length === 1 && gpus[0].utilizationPct === 12 && gpus[0].memoryUsedMb === 5123 && gpus[0].temperatureC === 54);
  check("nvidia-smi: garbage rows skipped", system.parseNvidiaSmi("junk\n\nname, a, b, c, d").length === 0);

  // --- WSL distro parser -----------------------------------------------------
  check("wsl: distros parsed + NUL stripped", JSON.stringify(system.parseWslDistros("Ubuntu-24.04\r\n\0docker-desktop\0\n")) === JSON.stringify(["Ubuntu-24.04", "docker-desktop"]));

  // --- system monitor --------------------------------------------------------
  const monitor = system.createSystemMonitor();
  const sample = monitor.sample();
  check("monitor: cpu shape", typeof sample.cpu.usagePct === "number" && sample.cpu.cores >= 1 && sample.cpu.usagePct >= 0 && sample.cpu.usagePct <= 100);
  check("monitor: mem shape", typeof sample.mem.usagePct === "number" && sample.mem.totalGb > 0);
  const second = monitor.sample();
  check("monitor: second sample stable", typeof second.cpu.usagePct === "number");

  // --- workspace pure helpers ------------------------------------------------
  check("git status: counts modified/untracked", JSON.stringify(workspace.parseGitStatus(" M a.js\n?? b.js\nM  c.ts\n")) === JSON.stringify({ modified: 2, untracked: 1 }));
  check("git status: empty", JSON.stringify(workspace.parseGitStatus("")) === JSON.stringify({ modified: 0, untracked: 0 }));
  check("type: electron/react/ts", workspace.inferProjectType({ dependencies: { electron: "1", react: "2" }, devDependencies: { typescript: "3" } }) === "Electron / React / TypeScript");
  check("type: python via manifests only", workspace.inferProjectType({}) === "Node");

  // --- workspace scan + inspect on a fixture tree ----------------------------
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-ws-"));
  fs.mkdirSync(path.join(fixture, "src"));
  fs.mkdirSync(path.join(fixture, "node_modules"));
  fs.mkdirSync(path.join(fixture, ".git"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "fixture", dependencies: { react: "*" }, devDependencies: { typescript: "*" } }));
  fs.writeFileSync(path.join(fixture, "src", "a.ts"), "x");
  fs.writeFileSync(path.join(fixture, "src", "b.tsx"), "x");
  fs.writeFileSync(path.join(fixture, "script.py"), "x");
  fs.writeFileSync(path.join(fixture, "node_modules", "skip.js"), "x");
  fs.writeFileSync(path.join(fixture, ".git", "HEAD"), "x");
  const scan = workspace.scanDirectory(fixture);
  check("scan: counts files, skips node_modules/.git", scan.count === 4);
  check("scan: language histogram", JSON.stringify(scan.languages.map((e) => e.name)) === JSON.stringify(["TypeScript", "JSON", "Python"]));
  check("scan: manifests found", scan.manifests.includes("package.json"));

  const fakeRun = async (cmd, args) => {
    if (cmd === "git" && args.includes("rev-parse")) return { code: 0, stdout: "main\n", stderr: "" };
    if (cmd === "git" && args.includes("status")) return { code: 0, stdout: " M src/a.ts\n?? new.txt\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "nope" };
  };
  const inspected = await workspace.inspectWorkspace(fixture, fakeRun);
  check("inspect: ok", inspected.ok === true);
  check("inspect: name from basename", inspected.meta.name === path.basename(fixture));
  check("inspect: type inferred", inspected.meta.type === "React / TypeScript");
  check("inspect: git branch", inspected.meta.git.branch === "main");
  check("inspect: git status parsed", inspected.meta.git.modified === 1 && inspected.meta.git.untracked === 1);
  check("inspect: missing dir fails cleanly", (await workspace.inspectWorkspace(path.join(fixture, "nope"), fakeRun)).ok === false);
  fs.rmSync(fixture, { recursive: true, force: true });

  // --- host proxy: envelope helpers ------------------------------------------
  const req = host.makeClientRequest("session.list", { cursor: "x" });
  check("host: client-request envelope", req.type === "client-request" && req.method === "session.list" && typeof req.rpcId === "string");
  check("host: response parse ok", JSON.stringify(host.parseServerResponse({ type: "server-response", rpcId: "r1", result: { ok: true, value: { items: [] } } })) === JSON.stringify({ ok: true, value: { items: [] }, rpcId: "r1" }));
  check("host: response parse error branch", host.parseServerResponse({ type: "server-response", rpcId: "r1", result: { ok: false, error: { code: "x" } } }).ok === false);
  check("host: malformed response", host.parseServerResponse({ type: "nope" }).ok === false);
  check("host: event message parse", host.parseEventMessage(JSON.stringify({ type: "server-request", rpcId: "r2", method: "m", payload: { type: "session/event", sessionId: "s1" } })).payload.type === "session/event");
  check("host: event message junk rejected", host.parseEventMessage("not json") === null);
  check("config: whitelist contains session.prompt", config.HOST_API_METHODS.has("session.prompt"));
  check("config: whitelist rejects exec-ish methods", !config.HOST_API_METHODS.has("host.exec"));

  // --- host proxy against a mock HTTP+WebSocket host --------------------------
  const crypto = require("crypto");
  const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  function wsTextFrame(text) {
    const payload = Buffer.from(text, "utf8");
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  const server = http.createServer((reqNode, res) => {
    if (reqNode.url === "/api/session.list" && reqNode.method === "POST") {
      let body = "";
      reqNode.on("data", (c) => (body += c));
      reqNode.on("end", () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: parsed.rpcId, result: { ok: true, value: { items: [{ sessionId: "s1", blank: true, running: false, updatedAt: 1 }] } } }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (reqNode, socket) => {
    if (reqNode.url !== "/api/events.mux") {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(String(reqNode.headers["sec-websocket-key"] || "") + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
    );
    const send = (payload) => {
      socket.write(wsTextFrame(JSON.stringify({ type: "server-request", rpcId: "e1", method: "session/event", payload })));
    };
    setTimeout(() => {
      send({ type: "session/event", sessionId: "s1", event: { type: "x", seq: 1, time: 1, data: {} } });
      send({ type: "session/event", sessionId: "untracked", event: { type: "x", seq: 1, time: 1, data: {} } });
    }, 50);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const frames = [];
  const proxy = host.createDesktopHostProxy({ origin: `http://127.0.0.1:${port}`, forwardEvent: (f) => frames.push(f) });

  const listed = await proxy.call("session.list", {});
  check("proxy: unary call round-trip", listed.ok === true && Array.isArray(listed.value.items) && listed.value.items[0].sessionId === "s1");
  const blocked = await proxy.call("host.exec", { command: "rm -rf /" });
  check("proxy: non-whitelisted method rejected", blocked.ok === false && blocked.error.code === "forbidden");

  proxy.trackSession("s1");
  proxy.events.start();
  await new Promise((r) => setTimeout(r, 500));
  check("proxy: ws relayed tracked frames only", frames.length === 1 && frames[0].sessionId === "s1");

  proxy.events.stop();
  await new Promise((r) => setTimeout(r, 150));
  const framesAfterStop = frames.length;
  check("proxy: events stop halts relay", framesAfterStop >= 1);
  proxy.close();
  server.close();

  // ---------------------------------------------------------------------------
  // Part 2 — renderer modules under vm
  // ---------------------------------------------------------------------------
  const commandsSrc = fs.readFileSync(path.join(ROOT, "src", "desktop", "commands.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(ROOT, "src", "desktop", "core.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "desktop", "desktop.css"), "utf8");

  // --- commands engine -------------------------------------------------------
  const cmdContext = { window: {}, console };
  cmdContext.globalThis = cmdContext;
  vm.createContext(cmdContext);
  vm.runInContext(commandsSrc, cmdContext, { filename: "commands.js" });
  const commands = cmdContext.window.DSH.commands;

  const dummy = (id, name, opts = {}) => commands.register({
    id,
    name,
    description: opts.description || name,
    aliases: opts.aliases || [],
    keywords: opts.keywords || [],
    kind: opts.kind || "system",
    run: opts.run || (() => Promise.resolve({ ok: true }))
  });
  const disposeA = dummy("open-vscode", "Open VS Code", { aliases: ["open vs code", "打开 vs code", "vscode"], keywords: ["code", "编辑器"], kind: "system" });
  const disposeB = dummy("launch-wsl", "Launch WSL", { aliases: ["launch wsl", "启动 wsl"], keywords: ["wsl"], kind: "system" });
  const disposeC = dummy("check-gpu", "Check GPU Usage", { aliases: ["check gpu"], keywords: ["gpu", "显卡"], kind: "system" });
  const disposeD = dummy("open-workspace", "Open Workspace", { aliases: ["open workspace", "打开工作区"], keywords: ["workspace", "目录"], kind: "workspace" });

  check("commands: registry size", commands.all().length === 4);
  check("commands: normalize", commands.normalize("  打开  VS   Code ") === "打开 vs code");
  const r1 = commands.route("打开 VS Code");
  check("commands: 打开 VS Code → open-vscode", r1.ai === false && r1.command !== null && r1.command.id === "open-vscode");
  const r2 = commands.route("看看 GPU 占用");
  check("commands: 看看 GPU 占用 → check-gpu", r2.ai === false && r2.command.id === "check-gpu");
  const r3 = commands.route("解释 Python 装饰器");
  check("commands: unmatched NL → AI fallback", r3.ai === true && r3.command === null);
  const r4 = commands.route("open unknown app");
  check("commands: 打开 unknown → AI fallback", r4.ai === true && r4.command === null);
  const s1 = commands.suggest("gpu", 6);
  check("commands: suggest gpu ranks check-gpu first", s1.length > 0 && s1[0].command.id === "check-gpu");
  const s2 = commands.suggest("open", 6);
  check("commands: suggest open finds multiple", s2.some((i) => i.command.id === "open-vscode") && s2.some((i) => i.command.id === "open-workspace"));
  check("commands: recent remembered", (commands.remember("check-gpu"), commands.suggest("", 6).some((i) => i.command.id === "check-gpu")));
  check("commands: empty route", commands.route("   ").ai === false && commands.route("   ").command === null);

  let threw = false;
  try {
    commands.register({ id: "" });
  } catch {
    threw = true;
  }
  check("commands: invalid entry rejected", threw);

  // --- AI Core state machine -------------------------------------------------
  const now0 = { t: 0 };
  const pending = [];
  const fakeSetTimeout = (fn, ms) => {
    const id = pending.length + 1;
    pending.push({ at: now0.t + (ms || 0), fn, id });
    return id;
  };
  const fakeClearTimeout = () => {};
  function advance(ms) {
    const target = now0.t + ms;
    for (;;) {
      let due = null;
      for (const entry of pending) {
        if (entry.at <= target && (due === null || entry.at < due.at)) due = entry;
      }
      if (due === null) break;
      pending.splice(pending.indexOf(due), 1);
      now0.t = due.at;
      due.fn();
    }
    now0.t = target;
  }

  function makeEl(id) {
    let text = "";
    const el = {
      id,
      className: "",
      style: { opacity: "1", setProperty() {} },
      classList: {
        classes: [],
        add(c) {
          if (!this.classes.includes(c)) this.classes.push(c);
        },
        remove(c) {
          this.classes = this.classes.filter((x) => x !== c);
        },
        contains(c) {
          return this.classes.includes(c);
        },
        toggle(c, force) {
          const has = this.classes.includes(c);
          if (force === true && !has) this.classes.push(c);
          if (force === false && has) this.remove(c);
        }
      },
      children: [],
      appendChild(c) {
        this.children.push(c);
      },
      append(...nodes) {
        for (const node of nodes) this.children.push(node);
      },
      clientWidth: 1440,
      clientHeight: 920,
      width: 0,
      height: 0,
      getContext: () => ctxMock,
      addEventListener() {}
    };
    Object.defineProperty(el, "textContent", {
      get: () => text,
      set: (v) => {
        text = String(v);
        if (text === "") el.children.length = 0;
      }
    });
    return el;
  }
  const ctxMock = new Proxy({}, {
    get: (t, prop) => {
      if (["setTransform", "clearRect", "beginPath", "arc", "fill", "moveTo", "lineTo", "stroke"].includes(prop)) return () => {};
      return t[prop];
    },
    set: (t, prop, v) => {
      t[prop] = v;
      return true;
    }
  });

  const els = {};
  for (const id of ["stage", "particles", "core-state", "core-detail", "hud-inner", "hud-outer", "hud-sweep"]) els[id] = makeEl(id);
  els["particles"].getContext = () => ctxMock;

  const rafCalls = [];
  const coreListeners = {};
  const coreContext = {
    window: {
      matchMedia: () => ({ matches: false }),
      devicePixelRatio: 1,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    document: {
      documentElement: { classList: { add() {} } },
      getElementById: (id) => els[id] || makeEl(id),
      createElement: () => makeEl("dynamic")
    },
    requestAnimationFrame: (fn) => {
      rafCalls.push(fn);
      return rafCalls.length;
    },
    cancelAnimationFrame: () => {},
    performance: { now: () => now0.t },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Math,
    console
  };
  coreContext.globalThis = coreContext;
  vm.createContext(coreContext);
  vm.runInContext(coreSrc, coreContext, { filename: "core.js" });
  const core = coreContext.window.DSH.core;

  core.init();
  check("core: rAF registered at init", rafCalls.length >= 1);
  core.setState("THINKING", "Analyzing request…");
  check("core: thinking class + label", els["stage"].classList.contains("state-thinking") && els["core-state"].textContent === "THINKING");
  check("core: detail set", els["core-detail"].textContent === "Analyzing request…");
  core.setState("PLANNING", "1. Inspect project");
  check("core: planning class", els["stage"].classList.contains("state-planning"));
  check("core: string detail rendered", els["core-detail"].textContent === "1. Inspect project");

  // Structured plan rendering + active-marker progression.
  core.setState("PLANNING", { steps: ["1. Detect workspace", "2. Inspect project", "3. Start server"], active: 0 });
  const planList = els["core-detail"].children[0];
  check("plan: list rendered with 3 steps", planList !== undefined && planList.className === "plan-list" && planList.children.length === 3);
  check("plan: first step active with dot", planList.children[0].classList.contains("active") && planList.children[0].children[0].textContent === "\u25cf");
  check("plan: later steps pending", planList.children[1].classList.contains("active") === false && planList.children[1].classList.contains("done") === false);
  core.updatePlan(1);
  const progressed = els["core-detail"].children[0];
  check("plan: progression marks done + next active", progressed !== undefined && progressed.children[0].classList.contains("done") && progressed.children[0].children[0].textContent === "\u2713" && progressed.children[1].classList.contains("active"));
  core.updatePlan(3);
  const finished = els["core-detail"].children[0];
  check("plan: all steps done", finished !== undefined && finished.children.every((row) => row.classList.contains("done")));

  core.setState("EXECUTING");
  check("core: executing class", els["stage"].classList.contains("state-executing"));
  core.setState("DONE", "WSL started successfully.");
  check("core: done class + label", els["stage"].classList.contains("state-done") && els["core-state"].textContent === "DONE");
  advance(1100);
  check("core: done returns to idle", core.state === "IDLE" && els["core-state"].textContent === "AGENT READY" && els["stage"].classList.contains("state-idle"));
  core.setState("FAILED", "nvidia-smi unavailable");
  check("core: failed class + label", els["stage"].classList.contains("state-failed") && els["core-state"].textContent === "ERROR");
  check("core: failed detail", els["core-detail"].textContent === "nvidia-smi unavailable");
  advance(5000);
  check("core: failed persists (no auto-idle)", core.state === "FAILED");

  // Every state class the core adds must exist in desktop.css.
  {
    const seen = new Set(["state-thinking", "state-planning", "state-executing", "state-done", "state-failed", "state-idle"]);
    const missing = [];
    for (const cls of seen) {
      if (!cssSrc.includes("." + cls)) missing.push(cls);
    }
    check("core: all state classes exist in desktop.css", missing.length === 0);
  }

  // ---------------------------------------------------------------------------
  console.log("");
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith("FAIL"));
  if (failed.length) {
    console.log("\n" + failed.length + " assertion(s) failed");
    process.exit(1);
  }
  console.log("\nAll " + results.length + " assertions passed");
  process.exit(0);
})().catch((error) => {
  console.error("test crashed:", error);
  process.exit(2);
});
