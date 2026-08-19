// Logic test for splash.js (Gen 2) — mocks the DOM/canvas and verifies the
// reconstruction timeline, typewriters, Workspace Online Confirmation, the
// AI Core Energy Gate handshake, cleanup, and reduced-motion behavior.
// Run under node.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const splashSrc = fs.readFileSync(path.join(ROOT, "src", "splash", "splash.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "src", "splash", "splash.css"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "main.js"), "utf8");
const preloadSrc = fs.readFileSync(path.join(ROOT, "src", "splash", "preload.js"), "utf8");

const results = [];
function check(name, cond) {
  results.push((cond ? "PASS " : "FAIL ") + name);
  if (!cond) console.log("       -> " + name + " FAILED");
}

// ---------------------------------------------------------------------------
// Scenario runner: builds a fresh mocked environment, runs splash.js, and
// hands back handles for assertions.
// ---------------------------------------------------------------------------
function runScenario(opts) {
  const reduced = !!opts.reduced;

  let now = 0;
  const pending = [];
  let nextTimerId = 1;
  let nextRafId = 1;
  const rafCalls = [];
  const rafCancels = [];
  const addedClasses = [];   // every classList.add("x") across elements
  const unknownIds = [];

  const fakeSetTimeout = (fn, ms) => {
    const id = nextTimerId++;
    pending.push({ at: now + (ms || 0), fn, id });
    return id;
  };
  const fakeClearTimeout = (id) => {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].id === id) pending.splice(i, 1);
    }
  };
  function advance(ms) {
    const target = now + ms;
    while (true) {
      let due = null;
      for (const t of pending) {
        if (t.at <= target && (due === null || t.at < due.at)) due = t;
      }
      if (!due) break;
      for (let i = 0; i < pending.length; i++) {
        if (pending[i].id === due.id) pending.splice(i, 1);
      }
      now = due.at;
      due.fn();
    }
    now = target;
  }

  function makeEl(id) {
    return {
      id,
      textContent: "",
      className: "",
      classList: {
        classes: [],
        add(c) {
          if (!this.classes.includes(c)) this.classes.push(c);
          addedClasses.push({ id, cls: c, when: now });
        },
        remove(c) {
          this.classes = this.classes.filter((x) => x !== c);
        },
        contains(c) {
          return this.classes.includes(c);
        }
      },
      style: {
        setProperty(k, v) {
          this[k] = v;
        }
      },
      attrs: {},
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      children: [],
      appendChild(c) {
        this.children.push(c);
      },
      clientWidth: 860,
      clientHeight: 500,
      width: 0,
      height: 0,
      getContext: null
    };
  }

  const ctxMock = new Proxy(
    {},
    {
      get: (t, prop) => {
        if (["setTransform", "clearRect", "beginPath", "arc", "fill"].includes(prop)) return () => {};
        return t[prop];
      },
      set: (t, prop, v) => {
        t[prop] = v;
        return true;
      }
    }
  );

  const els = {};
  const ids = [
    "stage", "particles", "data-chars", "init-text", "workspace-text",
    "workspace-cursor", "hud-inner", "hud-outer", "hud-sweep",
    "wave-svg", "wave-ring", "wave-ring-2"
  ];
  for (const id of ids) els[id] = makeEl(id);
  els["particles"].getContext = () => ctxMock;

  const documentEl = makeEl("documentElement");
  const listeners = {};

  const ipc = {
    onExitCb: null,
    revealCalls: [],
    exitDoneCalls: [],
    mainMotionCalls: [],
    exitVisualCalls: [],
    onExit(fn) {
      ipc.onExitCb = fn;
    },
    reveal() {
      ipc.revealCalls.push(now);
    },
    exitDone() {
      ipc.exitDoneCalls.push(now);
    },
    mainAnimationLastMotion(details) {
      ipc.mainMotionCalls.push({ now, details });
    },
    exitVisualStart(details) {
      ipc.exitVisualCalls.push({ now, details });
    }
  };

  const win = {
    location: { search: "?workspace=Harness%20Core%20Workspace&min=2200&intensity=1" },
    devicePixelRatio: 1,
    addEventListener: (ev, fn) => {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    removeEventListener: (ev, fn) => {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
    },
    matchMedia: () => ({ matches: reduced }),
    splashIpc: ipc
  };

  const documentMock = {
    documentElement: documentEl,
    getElementById: (id) => {
      if (els[id]) return els[id];
      unknownIds.push(id);
      return makeEl(id);
    },
    createElement: () => makeEl("dynamic")
  };

  const context = {
    window: win,
    document: documentMock,
    requestAnimationFrame: (fn) => {
      rafCalls.push(fn);
      return nextRafId++;
    },
    cancelAnimationFrame: (id) => {
      rafCancels.push(id);
    },
    performance: { now: () => now },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    URLSearchParams,
    Math,
    console
  };
  context.globalThis = context;
  vm.createContext(context);
  try {
    vm.runInContext(splashSrc, context, { filename: "splash.js" });
  } catch (e) {
    return { error: e, unknownIds };
  }

  return {
    els,
    documentEl,
    listeners,
    ipc,
    advance,
    pending: () => pending,
    rafCalls,
    rafCancels,
    addedClasses,
    unknownIds,
    triggerExit() {
      ipc.onExitCb();
    },
    triggerUnload() {
      for (const fn of listeners["beforeunload"] || []) fn();
    },
    stageClasses() {
      return els["stage"].classList.classes;
    }
  };
}

// ---------------------------------------------------------------------------
// Scenario A — full motion, IPC handshake
// ---------------------------------------------------------------------------
console.log("== Scenario A: full motion ==");
const A = runScenario({ reduced: false });
if (A.error) {
  console.log("Scenario A crashed: " + A.error.stack);
  process.exit(1);
}

// 13. DOM ids — every element the script asked for must exist.
check("A: all getElementById ids known", A.unknownIds.length === 0);

// 10/11. RAF registered by the particle system at boot.
check("A: rAF registered at boot", A.rafCalls.length === 1);

// t=0 state
check("A: init empty at t=0", A.els["init-text"].textContent === "");
check("A: workspace empty at t=0", A.els["workspace-text"].textContent === "");

// 1/7. Core pulse window (750..880ms)
A.advance(800);
check("A: core-pulse active at 800ms", A.stageClasses().includes("core-pulse"));
A.advance(100);
check("A: core-pulse released after pulse", !A.stageClasses().includes("core-pulse"));

// Core scan window (900..1230ms)
A.advance(60);
check("A: scanning active at ~960ms", A.stageClasses().includes("scanning"));
A.advance(290);
check("A: scanning released after scan", !A.stageClasses().includes("scanning"));

// data chars spawn at 1150
A.advance(100); // ~1350
check("A: data chars spawned", A.els["data-chars"].children.length > 0);

// 2. Initializing typing (starts 1250; 24 chars * 16ms = done ~1634)
A.advance(60); // ~1410
check("A: init typing in progress", A.els["init-text"].textContent.length > 0 && A.els["init-text"].textContent.length < 24);
A.advance(300); // ~1710
check("A: init fully typed", A.els["init-text"].textContent === "Initializing workspace...");

// 3/4. Workspace typing (starts 1550; done ~2149)
A.advance(150); // ~1860
check("A: workspace typing in progress", A.els["workspace-text"].textContent.length > 0 && A.els["workspace-text"].textContent.length < "Harness Core Workspace".length);
A.advance(350); // ~2210
check("A: workspace fully typed", A.els["workspace-text"].textContent === "Harness Core Workspace");
check("A: workspace cursor settled", A.els["workspace-cursor"].classList.contains("settle"));

// 6. Workspace confirmation (max(2180, done+90) = ~2239, released +620)
A.advance(90); // ~2300
check("A: confirming active", A.stageClasses().includes("confirming"));
A.advance(600); // ~2900
check("A: confirming released", !A.stageClasses().includes("confirming"));

// 8/9/15. Energy gate handshake: compress -> ring -> reveal -> exitDone.
// Gate timing is parsed from splash.js so the assertions track the constants
// instead of hard-coding milliseconds.
{
  const tv = (re) => {
    const m = splashSrc.match(re);
    if (!m) throw new Error("missing gate constant: " + re);
    return Number(m[1]);
  };
  const T = {
    compress: tv(/compressMs:\s*(\d+)/),
    reveal: tv(/revealAt:\s*(\d+)/),
    exitDone: tv(/exitDoneAt:\s*(\d+)/)
  };

  A.triggerExit();
  check("A: exit-compress immediate", A.stageClasses().includes("exit-compress"));
  check("A: main-motion boundary marked once", A.ipc.mainMotionCalls.length === 1);
  check("A: exit visual start marked once", A.ipc.exitVisualCalls.length === 1);
  check("A: no static gap at handoff boundary", A.ipc.mainMotionCalls[0].now === A.ipc.exitVisualCalls[0].now);
  check("A: exiting not yet at gate start", !A.stageClasses().includes("exiting"));
  check("A: reveal not called during compression", A.ipc.revealCalls.length === 0);
  A.advance(T.compress);
  check("A: exiting after compression", A.stageClasses().includes("exiting"));
  check("A: reveal not called at ring launch", A.ipc.revealCalls.length === 0);
  A.advance(T.reveal - T.compress - 1);
  check("A: reveal not yet mid-wave", A.ipc.revealCalls.length === 0);
  A.advance(1);
  check("A: reveal called during the opening wave", A.ipc.revealCalls.length === 1);
  check("A: reveal not duplicated", A.ipc.revealCalls.length === 1);
  check("A: exitDone not yet at reveal", A.ipc.exitDoneCalls.length === 0);
  A.advance(T.exitDone - T.reveal);
  check("A: exitDone called after fade", A.ipc.exitDoneCalls.length === 1);
  check("A: exitDone not duplicated", A.ipc.exitDoneCalls.length === 1);
  check("A: reveal before exitDone", A.ipc.revealCalls[0] < A.ipc.exitDoneCalls[0]);

  // Exit requests are idempotent: a second signal must not re-fire the handshake.
  A.triggerExit();
  A.advance(100);
  check("A: double exit ignored (reveal still once)", A.ipc.revealCalls.length === 1);
  check("A: double exit ignored (exitDone still once)", A.ipc.exitDoneCalls.length === 1);

  // Main-process fallback: reveal happens before close, and both handlers are
  // idempotent so the fallback can never double-show or double-destroy.
  check("A: main reveal handler idempotent", mainSrc.includes("if (revealed) return"));
  check("A: main finish handler idempotent", mainSrc.includes("if (finished) return"));
  check("A: fallback reveals before closing", /onReveal\(\);\s*\n\s*onFinished\(\);/.test(mainSrc));
  check("A: main opacity entrance present", mainSrc.includes("setOpacity(0.97)"));
  check("A: splash cross-fade overlaps Desktop", mainSrc.includes("fadeSplashWindow(splash)"));
  check("A: splash hide is instrumented", mainSrc.includes('startupMark("Splash hide"'));
}

// 10/11/12. Cleanup on window unload.
A.triggerUnload();
check("A: cancelAnimationFrame called on dispose", A.rafCancels.length === 1);
check("A: no pending timers after dispose", A.pending().length === 0);

// 14. Every class the renderer adds must exist in the CSS.
{
  const missing = [];
  const seen = new Set();
  for (const entry of A.addedClasses) {
    if (seen.has(entry.cls)) continue;
    seen.add(entry.cls);
    if (!cssSrc.includes("." + entry.cls)) missing.push(entry.cls);
  }
  check("A: all added classes exist in splash.css", missing.length === 0);
}

// 15. Main-process handoff wiring (source-level).
check("A: main registers splash:reveal channel", mainSrc.includes('SPLASH_REVEAL_CHANNEL = "splash:reveal"'));
check("A: main reveals window on splash:reveal", mainSrc.includes("revealMainWindow();"));
check("A: main waits for both reveal and exit-done", mainSrc.includes("SPLASH_EXIT_DONE_CHANNEL, onFinished"));
check("A: preload exposes reveal()", preloadSrc.includes('ipcRenderer.send("splash:reveal")'));
check("A: preload exposes exit visual marker", preloadSrc.includes('markStartup("Splash exit visual start"'));

// ---------------------------------------------------------------------------
// Scenario B — prefers-reduced-motion
// ---------------------------------------------------------------------------
console.log("== Scenario B: reduced motion ==");
const B = runScenario({ reduced: true });
if (B.error) {
  console.log("Scenario B crashed: " + B.error.stack);
  process.exit(1);
}

check("B: reduced class on documentElement", B.documentEl.classList.contains("reduced"));
B.advance(1);
check("B: init text instant", B.els["init-text"].textContent === "Initializing workspace...");
check("B: workspace text instant", B.els["workspace-text"].textContent === "Harness Core Workspace");
check("B: workspace cursor settled (reduced)", B.els["workspace-cursor"].classList.contains("settle"));
B.advance(1000);
check("B: no core-pulse in reduced mode", !B.stageClasses().includes("core-pulse"));
check("B: no confirming in reduced mode", !B.stageClasses().includes("confirming"));
check("B: fewer data chars in reduced mode", B.els["data-chars"].children.length <= 4);
check("B: rAF still registered once", B.rafCalls.length === 1);

B.triggerExit();
{
  const tv = (re) => Number(splashSrc.match(re)[1]);
  B.advance(tv(/compressMs:\s*(\d+)/) + tv(/exitDoneAt:\s*(\d+)/));
}
check("B: reveal still fires in reduced mode", B.ipc.revealCalls.length === 1);
check("B: exitDone still fires in reduced mode", B.ipc.exitDoneCalls.length === 1);
check("B: reduced exit handshake single-fire", B.ipc.revealCalls.length === 1 && B.ipc.exitDoneCalls.length === 1);
B.triggerUnload();
check("B: timers cleaned up in reduced mode", B.pending().length === 0);

// ---------------------------------------------------------------------------
console.log("");
for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith("FAIL"));
if (failed.length) {
  console.log("\n" + failed.length + " assertion(s) failed");
  process.exit(1);
}
console.log("\nAll " + results.length + " assertions passed");
