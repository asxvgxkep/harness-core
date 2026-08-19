// =============================================================================
// Workspace real-directory regression test (run under Electron-as-node).
//
// Guards the packaged-app bug found in live acceptance:
//   desktop:workspace:choose -> ReferenceError: basename is not defined
// The inlined desktop-workspace region of src/lib/main.js calls basename(root)
// but the bundle's node:path import line was missing `basename` (the standalone
// types file imported it correctly, which is why unit tests passed while the
// packaged exe crashed).
//
// Coverage (no mocks of path handling anywhere):
//   1. inspectWorkspace on the REAL Harness Core directory (the exact path the
//      acceptance flow selects) — name/files/languages/type, honest empty git.
//   2. inspectWorkspace on a REAL git repository created inside the workspace —
//      branch name and modified/untracked counts come from real `git` probes.
//   3. Static bundle hygiene: every node:path / node:fs helper the bundle
//      CALLS must appear in the corresponding top-level import.
// =============================================================================
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let failures = 0;

function assert(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined && detail !== "" ? " :: " + detail : ""}`);
}

(async () => {
  const workspace = await import(pathToFileURL(path.join(ROOT, "src", "lib", "types", "desktop-workspace.js")).href);
  const system = await import(pathToFileURL(path.join(ROOT, "src", "lib", "types", "desktop-system.js")).href);

  /* ---- 1. The real acceptance directory --------------------------------- */
  const realDir = path.join(ROOT);
  const real = await workspace.inspectWorkspace(realDir, system.runFixed);
  assert("real dir: ok", real.ok === true, String(real.reason ?? ""));
  assert(
    "real dir: name is path basename",
    real.meta !== undefined && real.meta.name === path.basename(realDir),
    real.meta && real.meta.name
  );
  assert(
    "real dir: files counted",
    real.meta !== undefined && real.meta.scan !== undefined && real.meta.scan.count > 0,
    String(real.meta && real.meta.scan && real.meta.scan.count)
  );
  assert(
    "real dir: languages detected",
    real.meta !== undefined && Array.isArray(real.meta.scan.languages) && real.meta.scan.languages.length > 0,
    JSON.stringify(real.meta && real.meta.scan.languages)
  );
  assert(
    "real dir: project type",
    real.meta !== undefined && typeof real.meta.type === "string" && real.meta.type !== "",
    String(real.meta && real.meta.type)
  );
  assert(
    "real dir: honest empty git (not a repository)",
    real.meta !== undefined && real.meta.git === null,
    JSON.stringify(real.meta && real.meta.git)
  );

  /* ---- 2. A real git repository fixture inside the workspace -------------- */
  const fixture = fs.mkdtempSync(path.join(ROOT, "build", "ws-git-fixture-"));
  try {
    const gitRun = (args) =>
      spawnSync("git", args, { encoding: "utf8", windowsHide: true, cwd: fixture });
    assert("fixture: git available", gitRun(["--version"]).status === 0, "");
    gitRun(["init", "-q"]);
    fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "fixture-app", dependencies: { electron: "^43" } }));
    fs.writeFileSync(path.join(fixture, "main.js"), "// app\n");
    gitRun(["add", "-A"]);
    gitRun(["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);
    fs.appendFileSync(path.join(fixture, "main.js"), "// edited\n");
    fs.writeFileSync(path.join(fixture, "notes.txt"), "untracked\n");

    const fixtureResult = await workspace.inspectWorkspace(fixture, system.runFixed);
    assert("fixture: ok", fixtureResult.ok === true, String(fixtureResult.reason ?? ""));
    assert(
      "fixture: name is path basename",
      fixtureResult.meta !== undefined && fixtureResult.meta.name === path.basename(fixture),
      fixtureResult.meta && fixtureResult.meta.name
    );
    assert(
      "fixture: git branch from real probe",
      fixtureResult.meta !== undefined && fixtureResult.meta.git !== null && typeof fixtureResult.meta.git.branch === "string" && fixtureResult.meta.git.branch !== "",
      JSON.stringify(fixtureResult.meta && fixtureResult.meta.git)
    );
    assert(
      "fixture: git modified=1 untracked=1",
      fixtureResult.meta !== undefined && fixtureResult.meta.git !== null && fixtureResult.meta.git.modified === 1 && fixtureResult.meta.git.untracked === 1,
      JSON.stringify(fixtureResult.meta && fixtureResult.meta.git)
    );
    assert(
      "fixture: type inferred from real package.json",
      fixtureResult.meta !== undefined && fixtureResult.meta.type === "Electron",
      String(fixtureResult.meta && fixtureResult.meta.type)
    );
  } finally {
    // git stores objects read-only; clear attributes before removal.
    const clearReadOnly = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        try {
          fs.chmodSync(full, 0o666);
        } catch {}
        if (entry.isDirectory()) clearReadOnly(full);
      }
    };
    clearReadOnly(fixture);
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  /* ---- 3. Bundle import hygiene (the actual regression) -------------------- */
  const bundle = fs.readFileSync(path.join(ROOT, "src", "lib", "main.js"), "utf8");
  const grabImport = (moduleName) => {
    const match = new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*["']${moduleName}["']`, "u").exec(bundle);
    return match ? match[0] : "";
  };
  const pathImport = grabImport("node:path");
  const fsImport = grabImport("node:fs");
  assert("bundle: has node:path import", pathImport !== "", "");
  assert("bundle: has node:fs import", fsImport !== "", "");

  // Every helper the bundle calls must be imported (usage = a call not
  // preceded by `.` or a word char, so Promise.resolve / arr.join don't count).
  const helpers = [
    ["node:path", pathImport, ["basename", "dirname", "extname", "relative", "normalize", "parse", "sep", "resolve", "join"]],
    ["node:fs", fsImport, ["existsSync", "readdirSync", "readFileSync", "statSync", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "copyFileSync", "unlinkSync"]]
  ];
  for (const [moduleName, importStmt, names] of helpers) {
    for (const name of names) {
      const used = new RegExp(`(?:^|[^.\\w])${name}\\(`, "u").test(bundle);
      if (!used) continue;
      const imported = new RegExp(`\\b${name}\\b`, "u").test(importStmt);
      assert(`bundle: ${name} used by inlined code => imported from ${moduleName}`, imported, importStmt.replace(/\s+/gu, " "));
    }
  }
  // The exact pair that regressed in live acceptance.
  assert("bundle: basename is imported", /\bbasename\b/u.test(pathImport), pathImport.replace(/\s+/gu, " "));

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error("TEST CRASHED:", error && error.stack ? error.stack : String(error));
  process.exit(2);
});
