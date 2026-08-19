const fs = require('fs');
const os = require('os');
const path = require('path');
const out = path.join(os.tmpdir(), 'dsh_node_probe.txt');
fs.writeFileSync(out, [
  'node=' + process.version,
  'electron=' + (process.versions.electron || 'none'),
  'platform=' + process.platform,
  'arch=' + process.arch,
  'cwd=' + process.cwd()
].join('\n'));
