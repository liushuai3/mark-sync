// Package the browser extension into a zip using the system `zip` binary.
// Avoids extra node deps (no root package.json here). Requires `zip` in PATH.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const src = process.env.SRC || path.resolve(__dirname, '..', 'extension');
const out =
  process.env.OUT ||
  path.resolve(__dirname, '..', 'web', 'dist', 'downloads', 'marksync-extension-latest.zip');

if (!fs.existsSync(src)) {
  console.error('❌ extension source not found:', src);
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(out)) fs.unlinkSync(out);

const excludes = [
  '.DS_Store',
  '*/.DS_Store',
  'docs/*',
  'docs/**',
  'CLAUDE.md',
  'TESTING.md',
];

try {
  execFileSync(
    'zip',
    ['-r', '-9', out, '.', '-x', ...excludes],
    { cwd: src, stdio: ['ignore', 'inherit', 'inherit'] }
  );
} catch (e) {
  console.error('❌ zip failed:', e.message);
  process.exit(1);
}

const size = fs.statSync(out).size;
console.log('✅ extension zip:', size, 'bytes ->', out);
