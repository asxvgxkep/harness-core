// Repack app.asar from the src/ tree (Node.js run under Electron-as-node).
// Mirrors the Chromium Pickle v2 layout that @electron/asar emits:
//   [0..3]   uint32 = 4
//   [4..7]   uint32 = headerSize
//   [8..11]  uint32 = headerSize - 4
//   [12..15] uint32 = json length
//   [16..]   JSON + 4-byte padding
//   then file data, contiguous, offsets relative to the data start.
const fs = require("fs");
const path = require("path");

// Electron-as-node wraps the `fs` module with an asar shim that refuses to write
// to any path containing ".asar". Disable it so we can emit the archive.
process.noAsar = true;

const SRC = process.argv[2] || "src";
const OUT = process.argv[3] || "build/app.asar";
// Optional `--name <value>`: repackage the same tree under a different
// package.json name. Used for the test copy so its Electron userData
// profile (and the userData-keyed single-instance lock) stay separate
// from the system-installed desktop app.
const NAME_OVERRIDE = (() => {
  const index = process.argv.indexOf("--name");
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return typeof value === "string" && value !== "" ? value : null;
})();

// Build intermediates that must not ship inside the asar.
const EXCLUDE = new Set(["whale-path.txt", "logo-original.svg"]);

function walk(dir, rel) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const relPath = rel ? rel + "/" + name : name;
    if (fs.statSync(full).isDirectory()) {
      out.push(...walk(full, relPath));
    } else {
      out.push({ relPath, full });
    }
  }
  return out;
}

const whalePathFile = path.join(SRC, "splash", "whale-path.txt");
const whalePath = fs.existsSync(whalePathFile)
  ? fs.readFileSync(whalePathFile, "utf8").trim()
  : "";

const files = walk(SRC, "")
  .filter((f) => !EXCLUDE.has(path.basename(f.relPath)))
  .sort((a, b) => a.relPath.localeCompare(b.relPath));

const tree = { files: {} };
const records = [];
let offset = 0;

for (const f of files) {
  let content = fs.readFileSync(f.full);
  if (f.relPath === "splash/splash.html") {
    content = Buffer.from(
      content.toString("utf8").replace("__WHALE_PATH__", whalePath),
      "utf8"
    );
  }
  if (f.relPath === "package.json" && NAME_OVERRIDE !== null) {
    const pkg = JSON.parse(content.toString("utf8"));
    pkg.name = NAME_OVERRIDE;
    content = Buffer.from(JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }
  const parts = f.relPath.split("/");
  let node = tree.files;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]]) node[parts[i]] = { files: {} };
    node = node[parts[i]].files;
  }
  node[parts[parts.length - 1]] = { size: content.length, offset: String(offset) };
  records.push({ content, size: content.length, offset, relPath: f.relPath });
  offset += content.length;
}

const json = JSON.stringify(tree);
const jsonBuf = Buffer.from(json, "utf8");
const jsonLen = jsonBuf.length;
const pad = (4 - ((8 + jsonLen) % 4)) % 4;
const headerSize = 8 + jsonLen + pad;

const total = 8 + headerSize + offset;
const out = Buffer.alloc(total);
out.writeUInt32LE(4, 0);
out.writeUInt32LE(headerSize, 4);
out.writeUInt32LE(headerSize - 4, 8);
out.writeUInt32LE(jsonLen, 12);
jsonBuf.copy(out, 16);

let pos = 8 + headerSize;
for (const r of records) {
  r.content.copy(out, pos);
  pos += r.content.length;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);

console.log("packed " + OUT + " (" + total + " bytes, " + records.length + " files)");
for (const r of records) console.log("  " + r.offset + "  " + r.size + "  " + r.relPath);
