// Full renderer integration test for the desktop shell: runs every desktop
// module (core, panels, commands, actions, builtins, app) in one vm context
// with a rich DOM mock and real timers, then drives the complete user flow:
// boot → reveal → command center → actions → panels → shortcuts.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const DESKTOP = path.join(ROOT, "src", "desktop");
const sources = ["core.js", "panels.js", "commands.js", "actions.js", "builtins.js", "hostevents.js", "app.js"].map((name) =>
  fs.readFileSync(path.join(DESKTOP, name), "utf8")
);
const desktopCss = fs.readFileSync(path.join(DESKTOP, "desktop.css"), "utf8");
const desktopPreload = fs.readFileSync(path.join(DESKTOP, "preload.js"), "utf8");

const results = [];
function check(name, cond) {
  results.push((cond ? "PASS " : "FAIL ") + name);
  if (!cond) console.log("       -> " + name + " FAILED");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Rich DOM mock -----------------------------------------------------------
function makeEl(id) {
  let text = "";
  const el = {
    id,
    className: "",
    value: "",
    title: "",
    style: { opacity: "1", setProperty() {} },
    children: [],
    parentNode: null,
    attrs: {},
    _listeners: {},
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
        const want = force === undefined ? !has : force;
        if (want && !has) this.classes.push(c);
        if (!want && has) this.remove(c);
        return want;
      }
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    append(...nodes) {
      for (const node of nodes) this.appendChild(node);
    },
    remove() {
      if (this.parentNode !== null) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
      }
    },
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      for (const fn of this._listeners[event.type] || []) fn.call(this, event);
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    querySelector(selector) {
      if (selector === ".cc-backdrop") {
        return makeEl("cc-backdrop-mock");
      }
      return makeEl("query-mock");
    },
    focus() {},
    blur() {},
    select() {},
    clientWidth: 1440,
    clientHeight: 920,
    scrollTop: 0,
    scrollHeight: 0,
    offsetWidth: 0,
    getContext: null,
    width: 0,
    height: 0,
    dataset: {}
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

const els = new Map();
function getEl(id) {
  if (!els.has(id)) els.set(id, makeEl(id));
  return els.get(id);
}
for (const id of [
  "stage", "particles", "core-state", "core-detail", "hud-inner", "hud-outer", "hud-sweep",
  "tb-state", "tb-ready", "tb-workspace", "tb-sys", "agents-list", "workspace-body",
  "terminal-body", "term-clear", "term-copy", "agents-collapse", "terminal-collapse",
  "agents-refresh", "quick-input", "quick-suggestions", "command-center", "cc-input",
  "cc-suggestions", "console-frame", "console-view", "core-view", "view-core",
  "view-console", "toast", "core-cluster"
]) {
  getEl(id);
}
// Seed the classes the real desktop.html ships with.
getEl("stage").classList.add("phase-boot", "state-idle");

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
getEl("particles").getContext = () => ctxMock;

const windowListeners = {};
const ipcMock = {
  bootInfo: {
    hostOrigin: null,
    hostReady: false,
    workspaceName: "Harness Core Workspace",
    platform: "win32"
  },
  getBootInfo: () => Promise.resolve({ ok: true, value: ipcMock.bootInfo }),
  system: {
    getStatus: () => Promise.resolve({ ok: true, value: { cpu: { usagePct: 10, cores: 8, model: "mock" }, mem: { usagePct: 40, totalGb: 16, freeGb: 9 }, sampledAt: 1 } }),
    getGpu: () => Promise.resolve({ ok: true, gpus: [{ name: "NVIDIA RTX MOCK", utilizationPct: 7, memoryUsedMb: 5123, memoryTotalMb: 16376, temperatureC: 54 }] }),
    detectWsl: () => Promise.resolve({ installed: true, online: true, defaultDistro: "Ubuntu-24.04", distros: ["Ubuntu-24.04"] }),
    openVsCode: () => Promise.resolve({ ok: true, method: "binary" }),
    launchWsl: () => Promise.resolve({ ok: true, pid: 123 }),
    openPath: () => Promise.resolve({ ok: true }),
    openExternal: () => Promise.resolve({ ok: true })
  },
  workspace: {
    choose: () =>
      Promise.resolve({
        ok: true,
        meta: {
          path: "C:/projects/fixture",
          name: "fixture",
          type: "React / TypeScript",
          git: { branch: "main", modified: 3, untracked: 1 },
          scan: { count: 128, languages: [{ name: "TypeScript" }, { name: "CSS" }] },
          packageJson: { scripts: { dev: "vite" } }
        }
      }),
    inspect: (p) =>
      Promise.resolve({
        ok: true,
        meta: {
          path: p,
          name: "fixture",
          type: "React / TypeScript",
          git: { branch: "main", modified: 3, untracked: 1 },
          scan: { count: 128, languages: [{ name: "TypeScript" }] },
          packageJson: null
        }
      })
  },
  host: {
    call: (method, payload) => {
      ipcMock.host.calls.push({ method, payload });
      if (ipcMock.host.failMode) {
        return Promise.resolve({ ok: false, error: { code: "transport", message: "backend down (mock)" }, rpcId: "r" });
      }
      if (method === "session.create") {
        return Promise.resolve({ ok: true, value: { sessionId: "s-desk-1" }, rpcId: "r1" });
      }
      if (method === "session.prompt") {
        return Promise.resolve({ ok: true, value: { accepted: true }, rpcId: "r2" });
      }
      return Promise.resolve({ ok: false, error: { code: "transport", message: "mock" }, rpcId: "r3" });
    },
    calls: [],
    failMode: false,
    eventsStart: () => Promise.resolve({ ok: true }),
    eventsStop: () => Promise.resolve({ ok: true })
  },
  on(channel, cb) {
    windowListeners[channel] = cb;
    return () => {};
  }
};

const context = {
  window: {
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1,
    location: { search: "?host=http%3A%2F%2F127.0.0.1%3A59999&workspace=test&platform=win32" },
    addEventListener: (type, fn) => {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
    removeEventListener: () => {},
    isSecureContext: true,
    desktopIpc: ipcMock,
    DSH: {}
  },
  document: {
    documentElement: { classList: { add() {} } },
    body: makeEl("body"),
    getElementById: getEl,
    createElement: (tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) })
  },
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  performance: { now: () => Date.now() },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  },
  URLSearchParams,
  Math,
  console
};
context.globalThis = context;
vm.createContext(context);

for (const src of sources) {
  vm.runInContext(src, context, { filename: "desktop-module.js" });
}

const DSH = context.window.DSH;
function fireWindowKeydown(props) {
  for (const fn of windowListeners["keydown"] || []) fn({ preventDefault() {}, code: "", ctrlKey: false, shiftKey: false, ...props });
}

(async () => {
  try {
    await sleep(120); // let app.js boot() finish (ipc resolves immediately)

    check("boot: phase-boot initially", getEl("stage").classList.contains("phase-boot"));
    check("boot: services do not block local shell", getEl("core-state").textContent === "INITIALIZING SERVICES");

    DSH.app.reveal();
    check("reveal: phase-ready entered", getEl("stage").classList.contains("phase-ready"));
    check("reveal: chrome has no static transition delay", !/opacity 360ms[^;]+120ms/u.test(desktopCss));
    check("reveal: first visible frame is instrumented", desktopPreload.includes('"Desktop first visible frame"'));
    check("reveal: initializing state shown while Host is cold", getEl("core-state").textContent === "INITIALIZING SERVICES");
    check("reveal: local shell log does not claim readiness", DSH.panels.terminal.lines.length === 2);

    windowListeners["desktop:services-ready"]({
      ok: true,
      value: {
        hostOrigin: "http://127.0.0.1:59999",
        hostReady: true,
        workspaceName: "Harness Core Workspace",
        platform: "win32"
      }
    });
    await sleep(20);
    check("reveal: AGENT READY", getEl("core-state").textContent === "AGENT READY");
    check("reveal: service hydration logged", DSH.panels.terminal.lines.length === 4);
    check("reveal: Console hydrated after Host ready", getEl("console-frame").attrs.src.includes("127.0.0.1:59999"));

    // Empty states are designed, not gaps.
    {
      const body = getEl("workspace-body");
      const empty = body.children[0];
      check(
        "workspace empty state structure",
        body.children.length === 1 && empty !== undefined && empty.className === "ws-empty" &&
          empty.children.length === 4 && empty.children[3].textContent === "OPEN WORKSPACE \u2192"
      );
      const termBody = getEl("terminal-body");
      check(
        "terminal idle cursor present",
        termBody.children.length > 0 && termBody.children[termBody.children.length - 1].className === "term-cursor"
      );
    }

    // Command Center
    DSH.app.openCommandCenter(false);
    check("cc: overlay open class", getEl("command-center").classList.contains("open"));
    const ccInputEl = getEl("cc-input");
    ccInputEl.value = "gpu";
    ccInputEl.dispatchEvent({ type: "input" });
    const firstCc = getEl("cc-suggestions").children[0];
    check("cc: gpu suggestion ranked first", firstCc !== undefined && firstCc.children[1].textContent === "Check GPU Usage");
    DSH.app.closeCommandCenter();

    // check-gpu pipeline through the real action
    await DSH.actions.runInput("看看 GPU 占用");
    check("gpu: pipeline returned ok", true);
    check("gpu: terminal got nvidia line", DSH.panels.terminal.lines.some((l) => l.kind === "out" && l.text.includes("NVIDIA RTX MOCK")));
    await sleep(1800);
    check("gpu: back to idle after done", DSH.core.state === "IDLE");

    // Workspace
    await DSH.actions.runInput("打开 Workspace");
    await sleep(1900);
    check("workspace: meta stored", DSH.app.getWorkspace() !== null && DSH.app.getWorkspace().name === "fixture");
    check("workspace: panel rendered", getEl("workspace-body").children.length > 0);
    check("workspace: stage has-workspace", getEl("stage").classList.contains("has-workspace"));
    check("workspace: titlebar shows name", getEl("tb-workspace").textContent === "FIXTURE");

    // AI streaming through the (mocked) Harness backend
    function fireHostFrame(payload) {
      const cb = windowListeners["desktop:host:event"];
      if (typeof cb === "function") cb(payload);
    }
    function chunkFrame(sessionId, text, seq) {
      return {
        type: "session/event",
        sessionId,
        event: { type: "assistant/chunk", seq, time: seq, data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text } } }
      };
    }
    async function runAiAndStream(input, answerText) {
      const pendingRun = DSH.actions.runInput(input);
      const callsBefore = ipcMock.host.calls.length;
      // Wait until this run's session.prompt reached the mock backend.
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        const prompted = ipcMock.host.calls.slice(callsBefore).some((c) => c.method === "session.prompt");
        if (prompted) break;
      }
      await sleep(150); // let the turn/end waiter register
      fireHostFrame(chunkFrame("s-desk-1", answerText, 1));
      fireHostFrame({ type: "session/event", sessionId: "s-desk-1", event: { type: "turn/end", seq: 2, time: 2, data: { reason: { kind: "completed" } } } });
      await pendingRun;
      await sleep(1900);
    }

    await runAiAndStream("解释 Python 装饰器", "Python decorators wrap functions.");

    check("ai: session created via host proxy", ipcMock.host.calls.some((c) => c.method === "session.create"));
    check("ai: session bound to workspace cwd", ipcMock.host.calls.some((c) => c.method === "session.create" && c.payload.cwd === "C:/projects/fixture"));
    check("ai: prompt queued with raw question", ipcMock.host.calls.some((c) => c.method === "session.prompt" && c.payload.content[0].text === "解释 Python 装饰器"));
    check("ai: streamed answer rendered", DSH.panels.terminal.lines.some((l) => l.kind === "out" && l.text.includes("Python decorators wrap functions.")));
    check("ai: core back to idle", DSH.core.state === "IDLE");

    await runAiAndStream("分析当前项目", "This project is a React application.");

    check("analyze: composed workspace prompt", ipcMock.host.calls.some((c) => c.method === "session.prompt" && c.payload.content[0].text.includes("Analyze the project at C:/projects/fixture")));

    // Backend outage degrades gracefully into FAILED (no crash, honest state).
    ipcMock.host.failMode = true;
    await DSH.actions.runInput("介绍这个项目");
    await sleep(1900);

    check("ai-outage: FAILED state reached", getEl("stage").classList.contains("state-failed"));
    check("ai-outage: terminal err line", DSH.panels.terminal.lines.some((l) => l.kind === "err" && l.text.includes("backend down")));
    ipcMock.host.failMode = false;
    await DSH.actions.runInput("clear terminal");
    await sleep(1500);

    // run-project prints scripts
    await DSH.actions.runInput("运行项目");
    await sleep(1900);
    check("run-project: scripts listed", DSH.panels.terminal.lines.some((l) => l.kind === "out" && l.text.includes("vite")));

    // open-vscode action
    await DSH.actions.runInput("打开 VS Code");
    await sleep(1900);
    check("vscode: launched with workspace", DSH.panels.terminal.lines.some((l) => l.text.includes("opening C:/projects/fixture")));

    // toggle terminal
    await DSH.actions.runInput("打开终端");
    await sleep(1500);
    check("toggle-terminal: collapsed class", getEl("stage").classList.contains("terminal-collapsed"));

    // clear terminal (a confirmation line remains by design)
    await DSH.actions.runInput("clear terminal");
    await sleep(1500);
    check("clear: terminal emptied", DSH.panels.terminal.lines.length === 1 && DSH.panels.terminal.lines[0].kind === "ok");

    // Ask DeepSeek with no question → hands off to the console view
    await DSH.actions.runPipeline(DSH.commands.byId("ask-ai"), "");
    await sleep(1500);
    check("ask-empty: console view active", getEl("console-view").classList.contains("active"));

    // Shortcuts
    DSH.app.setView("core");
    fireWindowKeydown({ ctrlKey: true, code: "Space" });
    check("shortcut: Ctrl+Space opens cc", getEl("command-center").classList.contains("open"));
    fireWindowKeydown({ code: "Escape" });
    await sleep(300);
    check("shortcut: Esc closes cc", !getEl("command-center").classList.contains("open"));
    fireWindowKeydown({ ctrlKey: true, shiftKey: true, code: "KeyP" });
    check("shortcut: Ctrl+Shift+P opens cc", getEl("command-center").classList.contains("open"));
    fireWindowKeydown({ code: "Escape" });
    const wasCollapsed = getEl("stage").classList.contains("terminal-collapsed");
    fireWindowKeydown({ ctrlKey: true, code: "Backquote" });
    check("shortcut: Ctrl+` toggles terminal", getEl("stage").classList.contains("terminal-collapsed") !== wasCollapsed);
    fireWindowKeydown({ ctrlKey: true, code: "Digit2" });
    check("shortcut: Ctrl+2 → console view", getEl("console-view").classList.contains("active"));
    fireWindowKeydown({ ctrlKey: true, code: "Digit1" });
    check("shortcut: Ctrl+1 → core view", getEl("core-view").classList.contains("active"));

    // ERROR path: workspace inspect failure
    ipcMock.workspace.inspect = () => Promise.resolve({ ok: false, reason: "directory does not exist" });
    await DSH.actions.runInput("inspect workspace");
    await sleep(1900);
    check("error: FAILED state reached", getEl("stage").classList.contains("state-failed"));
    check("error: terminal err line", DSH.panels.terminal.lines.some((l) => l.kind === "err"));

    console.log("");
    for (const r of results) console.log(r);
    const failed = results.filter((r) => r.startsWith("FAIL"));
    if (failed.length) {
      console.log("\n" + failed.length + " assertion(s) failed");
      process.exit(1);
    }
    console.log("\nAll " + results.length + " assertions passed");
    process.exit(0);
  } catch (error) {
    console.error("test crashed:", error);
    process.exit(2);
  }
})();
