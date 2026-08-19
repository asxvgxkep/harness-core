/* =============================================================================
   REAL-APP INTEGRATION VERIFIER (run detached under Electron-as-node).
   Verifies the assembled test copy end to end:

     Boot Sequence -> Harness Core Desktop Shell -> AGENT READY
     Command Center (real Ctrl+Space / Escape key events)
     GPU (real nvidia-smi) / WSL (real wsl.exe detect + launch)
     Workspace (real directory inspection + panel render)
     DeepSeek Host (host.describe / session.list through the real proxy)
     CONSOLE (real DSH Web GUI in the embedded iframe, verified in its own
              CDP execution context)
     Quit -> relaunch -> still ready (persistence)

   The desktop exe enforces a single running instance, so this script first
   waits until every "DeepSeek Harness.exe" instance has exited (itself
   excluded), then launches the GUI app with a remote debugging port and
   drives it over the Chrome DevTools Protocol. No fixtures: every check
   reads live state from the real app.

   Outputs:
     build/real-app-shots/*.png          screenshots
     build/real-app-verify-app1.log      main-process output of launch 1
     build/real-app-verify-app2.log      main-process output of launch 2
     build/real-app-verify.log           driver log
     build/real-app-verify-result.json   machine-readable results
     build/real-app-verify-done.txt      completion marker + summary
   ============================================================================= */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TEST_WORKSPACE = ROOT;
const TEST_WORKSPACE_NAME = path.basename(TEST_WORKSPACE);
const EXE = path.join(ROOT, "test-app", "DeepSeek Harness.exe");
const OUT = path.join(ROOT, "build", "real-app-shots");
const DEBUG_PORT = 9333;
const LOG = path.join(ROOT, "build", "real-app-verify.log");
const RESULT = path.join(ROOT, "build", "real-app-verify-result.json");
const DONE = path.join(ROOT, "build", "real-app-verify-done.txt");
const APP1_LOG = path.join(ROOT, "build", "real-app-verify-app1.log");
const APP2_LOG = path.join(ROOT, "build", "real-app-verify-app2.log");
const START_MARKER = path.join(ROOT, "build", "real-app-verify-started.txt");
const PROFILE = path.join(ROOT, "build", "real-app-profile");
const WAIT_DEADLINE_MS = 40 * 60 * 1000;
const HARD_CAP_MS = 14 * 60 * 1000;

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const checks = [];
let startedAt = Date.now();
let launchIndex = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.appendFileSync(LOG, line + "\n");
  } catch {}
  console.log(line);
}

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: String(detail ?? "") });
  log(`CHECK ${ok ? "PASS" : "FAIL"} :: ${name} :: ${detail ?? ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- instance tracking ----------------------------------------------------- */
function instancePids() {
  const res = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true
  });
  const pids = [];
  for (const line of String(res.stdout || "").split(/\r?\n/)) {
    const match = /^"DeepSeek Harness\.exe","(\d+)"/u.exec(line.trim());
    if (match !== null) pids.push(Number(match[1]));
  }
  return pids;
}

async function waitForZeroInstances(deadlineMs) {
  log("waiting for every desktop instance to exit (self PID " + process.pid + " excluded)");
  while (Date.now() - startedAt < deadlineMs) {
    const others = instancePids().filter((pid) => pid !== process.pid);
    if (others.length === 0) {
      log("no desktop instances remain");
      await sleep(8000); // let the OS and profile locks settle
      return true;
    }
    log("still running: " + others.join(", "));
    await sleep(4000);
  }
  log("timed out waiting for the desktop instance to close");
  return false;
}

/* ---- CDP ------------------------------------------------------------------- */
class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.ws = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP websocket error")), { once: true });
      this.ws.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        const pending = this.pending.get(msg.id);
        if (pending !== undefined) {
          this.pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message || "CDP error"));
          else pending.resolve(msg.result);
        }
      });
    });
  }
  send(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function waitForDebugTarget(listPath, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const data = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}${listPath}`);
      if (Array.isArray(data)) {
        const hit = data.find(predicate);
        if (hit !== undefined) return hit;
      } else if (predicate(data)) {
        return data;
      }
    } catch {}
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function evaluate(client, expression, { awaitPromise = false, timeoutMs = 20000 } = {}) {
  const response = client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise
  });
  const timed = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs));
  const result = await Promise.race([response, timed]);
  if (result && result.timedOut) return { timedOut: true };
  if (result.exceptionDetails) {
    return { error: (result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text || "exception" };
  }
  return { value: result.result && result.result.value };
}

async function screenshot(client, name) {
  const result = await client.send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(result.data, "base64");
  fs.writeFileSync(path.join(OUT, name + ".png"), buf);
  log("captured " + name + " (" + buf.length + " bytes)");
}

async function dispatchKey(client, type, code, key, windowsVirtualKeyCode, modifiers = 0) {
  await client.send("Input.dispatchKeyEvent", {
    type,
    modifiers,
    code,
    key,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode
  });
}

function runPowershell(command) {
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  return String(res.stdout || "").trim();
}

function hostProcessPids() {
  const out = runPowershell(
    "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Where-Object { $_.CommandLine -match 'expose-internals' } | ForEach-Object { $_.ProcessId }"
  );
  return out.split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

function treeKill(pid) {
  const res = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
  return String(res.stdout || "") + String(res.stderr || "");
}

/* ---- app launch ------------------------------------------------------------- */
let currentChild = null;
let currentLogPath = null;

function launchApp() {
  launchIndex += 1;
  currentLogPath = launchIndex === 1 ? APP1_LOG : APP2_LOG;
  const logFd = fs.openSync(currentLogPath, "w");
  const appEnv = { ...process.env };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  log(`launching GUI app (launch ${launchIndex}, debug port ${DEBUG_PORT})`);
  currentChild = spawn(EXE, [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: false,
    env: appEnv
  });
  currentChild.unref();
  return currentChild.pid;
}

function stderrTail(logPath, lines) {
  try {
    const text = fs.readFileSync(logPath, "utf8");
    const all = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

async function quitApp(launchLabel) {
  // Preferred graceful path: kill the Host child; the main process treats
  // the unexpected Host exit as a full app quit (onUnexpectedExit ->
  // requestAppQuit -> disposeHost -> app.quit). This exercises the real
  // quit code path instead of force-killing the browser.
  const hostPids = hostProcessPids();
  let method = "none";
  if (hostPids.length > 0) {
    log(`killing Host child(ren) ${hostPids.join(", ")} to trigger the app quit path`);
    for (const pid of hostPids) treeKill(pid);
    method = "host-exit-auto-quit";
  } else {
    method = "host-not-found";
  }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const others = instancePids().filter((pid) => pid !== process.pid);
    if (others.length === 0) {
      log(`app quit via ${method}`);
      return method;
    }
    await sleep(1000);
  }
  log("graceful quit did not complete; force-killing the app tree");
  if (currentChild !== null && currentChild.pid !== undefined) {
    treeKill(currentChild.pid);
  } else {
    for (const pid of instancePids().filter((pid) => pid !== process.pid)) treeKill(pid);
  }
  await sleep(3000);
  return method + "+force-kill";
}

/* ---- one full verification cycle --------------------------------------------- */
async function verifyCycle(cycleLabel) {
  const cycle = { label: cycleLabel, screenshots: [] };
  let iframeEvidence = null;
  log(`==== ${cycleLabel} ====`);

  const appPid = launchApp();

  // Attach to the browser-level version endpoint first.
  await waitForDebugTarget("/json/version", () => true, 90000, "debug endpoint");

  // Splash window (boot sequence evidence).
  let splashSeen = false;
  try {
    const splashTarget = await waitForDebugTarget(
      "/json/list",
      (t) => t.type === "page" && t.url.includes("splash/splash.html"),
      45000,
      "splash target"
    );
    splashSeen = true;
    log("splash target seen: " + splashTarget.url);
    const splashClient = new CdpClient(splashTarget.webSocketDebuggerUrl);
    await splashClient.connect();
    try {
      await screenshot(splashClient, `${cycleLabel}-00-splash`);
      cycle.screenshots.push(`${cycleLabel}-00-splash`);
    } catch (error) {
      log("splash screenshot failed: " + error.message);
    }
    splashClient.close();
  } catch {
    log("splash target never appeared (host boot was too fast or window already transitioned)");
  }

  // Desktop page target.
  const pageTarget = await waitForDebugTarget(
    "/json/list",
    (t) => t.type === "page" && t.url.includes("desktop/desktop.html"),
    120000,
    "desktop page target"
  );
  log("desktop target: " + pageTarget.url);
  const client = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Page.enable");

  const domState = () =>
    evaluate(
      client,
      `(function(){
        const stage = document.getElementById("stage");
        return {
          stageClass: stage ? stage.className : null,
          coreState: (document.getElementById("core-state") || {}).textContent || null,
          tbState: (document.getElementById("tb-state") || {}).textContent || null,
          ccOpen: (document.getElementById("command-center") || { classList: { contains: () => false } }).classList.contains("open"),
          readyState: document.readyState,
          terminal: (window.DSH && DSH.panels ? DSH.panels.terminal.lines.map(l => l.kind + ":" + l.text) : [])
        };
      })()`
    );

  // Boot phase: capture before the reveal flips the stage.
  let bootCaptured = false;
  const bootDeadline = Date.now() + 10000;
  while (Date.now() < bootDeadline) {
    const state = await domState();
    if (state.timedOut || state.error) {
      await sleep(300);
      continue;
    }
    if (state.value && state.value.stageClass && state.value.stageClass.includes("phase-boot")) {
      await screenshot(client, `${cycleLabel}-01-boot`);
      cycle.screenshots.push(`${cycleLabel}-01-boot`);
      bootCaptured = true;
      break;
    }
    if (state.value && state.value.stageClass && state.value.stageClass.includes("phase-ready")) break;
    await sleep(250);
  }

  // Wait for the ready phase.
  let readyState = null;
  const readyDeadline = Date.now() + 45000;
  while (Date.now() < readyDeadline) {
    const state = await domState();
    if (state.timedOut || state.error) {
      await sleep(300);
      continue;
    }
    if (state.value && state.value.stageClass && state.value.stageClass.includes("phase-ready")) {
      readyState = state.value;
      break;
    }
    await sleep(300);
  }
  if (readyState === null) throw new Error("desktop never reached the ready phase");

  // phase-ready is the local-shell milestone; Host may legitimately still be
  // hydrating on a true cold start. Wait separately for AGENT READY.
  const servicesDeadline = Date.now() + 90000;
  while (Date.now() < servicesDeadline) {
    const serviceState = await domState();
    if (serviceState.value && String(serviceState.value.coreState).trim() === "AGENT READY") break;
    await sleep(300);
  }
  await sleep(300);
  const finalState = await domState();
  const state = (finalState.value && finalState.value) || {};

  check(`${cycleLabel}: splash window shown`, splashSeen, splashSeen ? "splash target captured" : "not observed");
  check(`${cycleLabel}: boot phase rendered`, bootCaptured, bootCaptured ? "phase-boot screenshot taken" : "boot phase had already completed when CDP attached");
  check(`${cycleLabel}: ready phase`, true, "stage.phase-ready");
  check(`${cycleLabel}: core state text`, String(state.coreState).trim() === "AGENT READY", `#core-state = ${JSON.stringify(state.coreState)}`);
  check(
    `${cycleLabel}: terminal AGENT READY`,
    Array.isArray(state.terminal) && state.terminal.some((line) => line.includes("AGENT READY")),
    JSON.stringify((state.terminal || []).slice(0, 6))
  );

  await screenshot(client, `${cycleLabel}-02-ready`);
  cycle.screenshots.push(`${cycleLabel}-02-ready`);

  // Boot info + Host origin.
  const bootInfoResult = await evaluate(client, `window.DSH.app.getBootInfo()`, { awaitPromise: false });
  const bootInfo = (bootInfoResult.value && bootInfoResult.value) || null;
  const hostOrigin = bootInfo ? bootInfo.hostOrigin : null;
  check(
    `${cycleLabel}: boot info`,
    bootInfo !== null && typeof hostOrigin === "string" && /^http:\/\/127\.0\.0\.1:\d+$/u.test(hostOrigin),
    JSON.stringify(bootInfo)
  );

  // Command Center via REAL keyboard input.
  await dispatchKey(client, "keyDown", "Space", " ", 32, 2);
  await dispatchKey(client, "keyUp", "Space", " ", 32, 2);
  await sleep(350);
  const ccOpenState = await domState();
  const ccOpened = !!(ccOpenState.value && ccOpenState.value.ccOpen);
  check(`${cycleLabel}: command center opens on Ctrl+Space`, ccOpened, "real key events dispatched");
  if (ccOpened) {
    await screenshot(client, `${cycleLabel}-03-command-center`);
    cycle.screenshots.push(`${cycleLabel}-03-command-center`);
  }
  await dispatchKey(client, "keyDown", "Escape", "Escape", 27, 0);
  await dispatchKey(client, "keyUp", "Escape", "Escape", 27, 0);
  await sleep(450);
  const ccClosedState = await domState();
  const ccClosed = !(ccClosedState.value && ccClosedState.value.ccOpen);
  check(`${cycleLabel}: command center closes on Escape`, ccClosed, "real key events dispatched");

  if (cycleLabel === "launch-1") {
    // GPU through the real command pipeline (Command Center input path).
    const gpuResult = await evaluate(
      client,
      `window.DSH.app.runInput("check gpu").then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, message: String(e) }))`,
      { awaitPromise: true, timeoutMs: 30000 }
    );
    const gpuJson = gpuResult.value ? JSON.parse(gpuResult.value) : null;
    await sleep(500);
    const afterGpu = await domState();
    const termLines = (afterGpu.value && afterGpu.value.terminal) || [];
    const gpuLine = termLines.find((line) => /NVIDIA|GeForce/iu.test(line)) || "";
    check(
      `${cycleLabel}: GPU check (real nvidia-smi)`,
      gpuJson !== null && gpuJson.ok === true && gpuLine !== "",
      gpuLine + " | result=" + (gpuResult.value || gpuResult.error || "")
    );
    await screenshot(client, `${cycleLabel}-04-gpu`);
    cycle.screenshots.push(`${cycleLabel}-04-gpu`);

    // WSL detection + launch (real wsl.exe).
    const wslDetect = await evaluate(client, `window.desktopIpc.system.detectWsl().then(JSON.stringify)`, {
      awaitPromise: true,
      timeoutMs: 20000
    });
    const wsl = wslDetect.value ? JSON.parse(wslDetect.value) : null;
    check(
      `${cycleLabel}: WSL detect`,
      wsl !== null && wsl.installed === true,
      wslDetect.value || String(wslDetect.error || "")
    );
    let wslLaunch = null;
    if (wsl !== null && wsl.installed) {
      const launchResult = await evaluate(client, `window.desktopIpc.system.launchWsl().then(JSON.stringify)`, {
        awaitPromise: true,
        timeoutMs: 20000
      });
      wslLaunch = launchResult.value ? JSON.parse(launchResult.value) : null;
      check(`${cycleLabel}: WSL launch`, wslLaunch !== null && wslLaunch.ok === true, JSON.stringify(wslLaunch));
      if (wslLaunch !== null && wslLaunch.ok && wslLaunch.pid) {
        log("cleaning up launched WSL console (pid " + wslLaunch.pid + ")");
        treeKill(wslLaunch.pid);
      }
    } else {
      check(`${cycleLabel}: WSL launch`, false, "skipped: WSL not detected");
    }

    // Workspace: inspect the real checkout through the packaged IPC handler,
    // then apply the returned metadata through the same renderer state path.
    const wsChooseRaw = await evaluate(
      client,
      `window.desktopIpc.workspace.inspect(${JSON.stringify(TEST_WORKSPACE)}).then(result => {
        if (result && result.ok) window.DSH.app.setWorkspace(result.meta);
        return JSON.stringify(result);
      }).catch(e => JSON.stringify({ ok: false, reason: String(e) }))`,
      { awaitPromise: true, timeoutMs: 60000 }
    );
    const wsChooseJson = wsChooseRaw.value ? JSON.parse(wsChooseRaw.value) : null;
    check(
      `${cycleLabel}: workspace inspect (real checkout)`,
      wsChooseJson !== null && wsChooseJson.ok === true && wsChooseJson.meta && wsChooseJson.meta.name === TEST_WORKSPACE_NAME,
      wsChooseRaw.value || String(wsChooseRaw.error || wsChooseRaw.timedOut ? "timed out" : "")
    );
    await sleep(600);
    const wsDom = await evaluate(
      client,
      `(function(){
        const body = document.getElementById("workspace-body");
        const tb = document.getElementById("tb-workspace");
        return { rows: body ? body.querySelectorAll(".ws-line").length : 0, tb: tb ? tb.textContent : null };
      })()`
    );
    check(
      `${cycleLabel}: workspace panel rendered`,
      wsDom.value !== undefined && wsDom.value.rows >= 5 && wsDom.value.tb === TEST_WORKSPACE_NAME.toUpperCase(),
      JSON.stringify(wsDom.value)
    );
    // Agent must settle back to READY after the pipeline finishes.
    let idle = false;
    const idleDeadline = Date.now() + 6000;
    while (Date.now() < idleDeadline) {
      const coreProbe = await evaluate(
        client,
        `(function(){ return { state: window.DSH.core.state, text: (document.getElementById("core-state") || {}).textContent }; })()`
      );
      if (coreProbe.value && coreProbe.value.state === "IDLE") {
        idle = true;
        break;
      }
      await sleep(400);
    }
    check(`${cycleLabel}: agent back to READY after workspace`, idle, "");
    await screenshot(client, `${cycleLabel}-05-workspace`);
    cycle.screenshots.push(`${cycleLabel}-05-workspace`);

    // DeepSeek Host connection through the real proxy.
    const hostDescribe = await evaluate(client, `window.desktopIpc.host.call("host.describe", {}).then(JSON.stringify)`, {
      awaitPromise: true,
      timeoutMs: 20000
    });
    const hostJson = hostDescribe.value ? JSON.parse(hostDescribe.value) : null;
    check(
      `${cycleLabel}: Host connection (host.describe)`,
      hostJson !== null && hostJson.ok === true && hostJson.value !== undefined,
      hostDescribe.value ? hostDescribe.value.slice(0, 400) : String(hostDescribe.error || "")
    );
    const sessionList = await evaluate(client, `window.desktopIpc.host.call("session.list", {}).then(JSON.stringify)`, {
      awaitPromise: true,
      timeoutMs: 20000
    });
    const sessionsJson = sessionList.value ? JSON.parse(sessionList.value) : null;
    check(
      `${cycleLabel}: Host session.list`,
      sessionsJson !== null && sessionsJson.ok === true,
      sessionsJson ? `sessions=${Array.isArray(sessionsJson.value && sessionsJson.value.sessions) ? sessionsJson.value.sessions.length : "?"}` : String(sessionList.error || "")
    );

    // Analyze Current Project through the real Host and streamed event path.
    const analyze = await evaluate(
      client,
      `window.DSH.app.runInput("analyze current project").then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, message: String(e) }))`,
      { awaitPromise: true, timeoutMs: 180000 }
    );
    const analyzeJson = analyze.value ? JSON.parse(analyze.value) : null;
    check(
      `${cycleLabel}: Analyze Current Project`,
      analyzeJson !== null && analyzeJson.ok === true,
      analyze.value || String(analyze.error || (analyze.timedOut ? "timed out" : ""))
    );
    const afterAnalyze = await domState();
    const analyzeErrors = Array.isArray(afterAnalyze.value && afterAnalyze.value.terminal)
      ? afterAnalyze.value.terminal.filter((line) => line.startsWith("err:"))
      : ["terminal unreadable"];
    check(
      `${cycleLabel}: Analyze stream has no error`,
      analyzeErrors.length === 0,
      JSON.stringify(analyzeErrors)
    );

    // CONSOLE: the real DSH Web GUI inside the embedded iframe.
    await evaluate(client, `window.DSH.app.setView("console"); true`);
    let consoleLoaded = false;
    const consoleDeadline = Date.now() + 60000;
    while (Date.now() < consoleDeadline) {
      const probe = await evaluate(
        client,
        `document.getElementById("console-view").classList.contains("loaded")`
      );
      if (probe.value === true) {
        consoleLoaded = true;
        break;
      }
      await sleep(500);
    }
    check(`${cycleLabel}: console view loaded`, consoleLoaded, "iframe fired load");

    try {
      const iframeTarget = await waitForDebugTarget(
        "/json/list",
        (t) => t.type === "iframe" && t.url.indexOf("127.0.0.1") !== -1,
        20000,
        "console iframe target"
      );
      log("console iframe target: " + iframeTarget.url);
      const iframeClient = new CdpClient(iframeTarget.webSocketDebuggerUrl);
      await iframeClient.connect();
      const inside = await evaluate(
        iframeClient,
        `(function(){
          const bodyText = document.body ? document.body.innerText || "" : "";
          return { title: document.title, readyState: document.readyState, bodyChars: bodyText.length, snippet: bodyText.slice(0, 300) };
        })()`
      );
      iframeEvidence = { url: iframeTarget.url, inside: inside.value };
      check(
        `${cycleLabel}: console shows the real Web GUI`,
        inside.value !== undefined && (inside.value.title || "").length > 0,
        `url=${iframeTarget.url} title=${JSON.stringify(inside.value && inside.value.title)} bodyChars=${inside.value && inside.value.bodyChars}`
      );
      await sleep(3000); // let the Web GUI finish its own boot
      // Page.captureScreenshot is only valid on a top-level target; capture
      // the Desktop page while the real Console iframe is visible.
      await screenshot(client, `${cycleLabel}-06-console`);
      cycle.screenshots.push(`${cycleLabel}-06-console`);
      iframeClient.close();
    } catch (error) {
      check(`${cycleLabel}: console shows the real Web GUI`, false, error.message);
    }
    await evaluate(client, `window.DSH.app.setView("core"); true`);

    // Final terminal snapshot.
    const endState = await domState();
    check(
      `${cycleLabel}: terminal populated`,
      Array.isArray(endState.value && endState.value.terminal) && endState.value.terminal.length >= 5,
      JSON.stringify((endState.value && endState.value.terminal) || [])
    );
    const errCount = Array.isArray(endState.value && endState.value.terminal)
      ? endState.value.terminal.filter((line) => line.startsWith("err:")).length
      : -1;
    check(`${cycleLabel}: terminal has no error lines`, errCount === 0, errCount === -1 ? "unreadable" : `${errCount} error line(s)`);
    if (endState.value && endState.value.terminal) {
      cycle.terminal = endState.value.terminal;
    }
  }

  cycle.bootInfo = bootInfo;
  cycle.iframeEvidence = iframeEvidence;
  cycle.quitMethod = await quitApp(cycleLabel);
  check(`${cycleLabel}: app exited`, instancePids().filter((pid) => pid !== process.pid).length === 0, cycle.quitMethod);
  await sleep(5000);
  return cycle;
}

/* ---- main -------------------------------------------------------------------- */
(async () => {
  fs.writeFileSync(START_MARKER, "started at " + new Date().toISOString() + "\n");
  try {
    if (!(await waitForZeroInstances(WAIT_DEADLINE_MS))) {
      fs.writeFileSync(DONE, "TIMED OUT waiting for the desktop instance to close\n");
      process.exit(1);
    }

    // Bound the verification itself (the user-exit wait above has its own,
    // longer deadline).
    const timeout = setTimeout(() => {
      log("HARD TIMEOUT");
      fs.writeFileSync(DONE, "HARD TIMEOUT — see " + LOG + "\n");
      process.exit(3);
    }, HARD_CAP_MS);

    const results = { startedAt: new Date(startedAt).toISOString(), checks: [], cycles: [] };
    const cycle1 = await verifyCycle("launch-1");
    results.cycles.push(cycle1);
    const cycle2 = await verifyCycle("launch-2");
    results.cycles.push(cycle2);

    results.checks = checks;
    results.app1StderrTail = stderrTail(APP1_LOG, 30);
    results.app2StderrTail = stderrTail(APP2_LOG, 30);
    results.finishedAt = new Date().toISOString();

    const failed = checks.filter((entry) => !entry.ok);
    fs.writeFileSync(RESULT, JSON.stringify(results, null, 2));

    const summary = [
      "REAL-APP VERIFY " + (failed.length === 0 ? "PASS" : "FAIL"),
      "finished: " + results.finishedAt,
      "checks: " + checks.length + " total, " + failed.length + " failed",
      ""
    ];
    for (const entry of checks) summary.push((entry.ok ? "[PASS] " : "[FAIL] ") + entry.name + " :: " + entry.detail);
    summary.push("");
    summary.push("screenshots: build/real-app-shots/");
    summary.push("driver log: build/real-app-verify.log");
    summary.push("app output: build/real-app-verify-app1.log, build/real-app-verify-app2.log");
    fs.writeFileSync(DONE, summary.join("\n") + "\n");

    clearTimeout(timeout);
    log("done; " + failed.length + " failed checks");
    process.exit(failed.length === 0 ? 0 : 2);
  } catch (error) {
    log("VERIFIER CRASHED: " + (error && error.stack ? error.stack : String(error)));
    checks.push({ name: "verifier-crashed", ok: false, detail: String(error && error.stack ? error.stack : error) });
    if (currentChild !== null && currentChild.pid !== undefined) {
      log("cleaning up app tree " + currentChild.pid);
      treeKill(currentChild.pid);
    }
    try {
      fs.writeFileSync(
        RESULT,
        JSON.stringify(
          {
            startedAt: new Date(startedAt).toISOString(),
            crashed: true,
            checks,
            app1StderrTail: stderrTail(APP1_LOG, 40),
            app2StderrTail: stderrTail(APP2_LOG, 40)
          },
          null,
          2
        )
      );
      fs.writeFileSync(DONE, "VERIFIER CRASHED: " + (error && error.stack ? error.stack : String(error)) + "\n");
    } catch {}
    process.exit(2);
  }
})();
