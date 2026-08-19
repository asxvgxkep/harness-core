// Detached auto-capture watcher (run under Electron-as-node).
// The desktop exe enforces a single running instance, so visual screenshots
// can only be taken between app runs. This watcher waits for every
// "DeepSeek Harness.exe" instance to exit (excluding its own PID), then
// launches the visual capture harness and records completion markers.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "build", "desktop-shots");
const doneFile = path.join(OUT, "auto-capture-done.txt");
const runLog = path.join(OUT, "auto-run.txt");

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  fs.rmSync(doneFile, { force: true });
  const deadline = Date.now() + 15 * 60 * 1000;
  let seenLiveInstance = false;

  // Wait until no desktop instance remains (ourselves excluded).
  while (instancePids().some((pid) => pid !== process.pid)) {
    seenLiveInstance = true;
    if (Date.now() > deadline) {
      fs.writeFileSync(doneFile, "TIMED OUT waiting for the desktop instance to close\n");
      process.exit(1);
    }
    await sleep(5000);
  }
  if (!seenLiveInstance) {
    // No instance at all: capture immediately.
    fs.writeFileSync(doneFile, "NO INSTANCE DETECTED\n");
  }

  await sleep(10000); // let the OS settle after close

  const logFd = fs.openSync(runLog, "w");
  const child = spawn(
    path.join(ROOT, "test-app", "DeepSeek Harness.exe"),
    [path.join(ROOT, "test-app", "verify-desktop")],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" }
    }
  );
  child.unref();

  // The harness process shares the exe name; wait for it to finish
  // (no instances left besides us), up to 2 minutes.
  let waited = 0;
  while (instancePids().some((pid) => pid !== process.pid) && waited < 120) {
    await sleep(2000);
    waited += 2;
  }
  fs.closeSync(logFd);
  fs.writeFileSync(doneFile, "HARNESS FINISHED at " + new Date().toISOString() + "\n");
  process.exit(0);
})().catch((error) => {
  try {
    fs.writeFileSync(doneFile, "WATCHER CRASHED: " + (error && error.stack ? error.stack : String(error)) + "\n");
  } catch {}
  process.exit(2);
});
