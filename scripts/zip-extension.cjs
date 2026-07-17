// Package the browser extension into a zip.
// Prefers 'archiver' (pure JS, works in Docker where NODE_PATH=/app/backend/node_modules has it).
// Falls back to system `zip` binary if archiver isn't available (dev host convenience).
const fs = require('fs');
const path = require('path');

const src = process.env.SRC || path.resolve(__dirname, '..', 'extension');

// Read version from manifest so the zip file is versioned (no more 'latest').
let version = process.env.VERSION;
if (!version) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
    version = m.version;
  } catch (e) {
    console.error('❌ cannot read manifest version:', e.message);
    process.exit(1);
  }
}

const defaultOutDir = path.resolve(__dirname, '..', 'web', 'dist', 'downloads');
const out = process.env.OUT || path.join(defaultOutDir, `marksync-extension-v${version}.zip`);

if (!fs.existsSync(src)) {
  console.error('❌ extension source not found:', src);
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(out)) fs.unlinkSync(out);

const excludes = [
  '.DS_Store',
  'CLAUDE.md',
  'TESTING.md',
];

function shouldExclude(relPath) {
  if (excludes.includes(relPath)) return true;
  if (relPath.endsWith('/.DS_Store') || relPath === '.DS_Store') return true;
  return false;
}

async function useArchiver() {
  let archiver;
  try {
    archiver = require('archiver');
  } catch {
    return false;
  }
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(out);
    const zip = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    zip.on('warning', (err) => (err.code === 'ENOENT' ? console.warn(err) : reject(err)));
    zip.on('error', reject);
    zip.pipe(output);

    // Walk src, honoring excludes
    const walk = (dir, base) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (shouldExclude(rel)) continue;
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else if (entry.isFile()) {
          zip.file(abs, { name: rel });
        }
      }
    };
    walk(src, '');
    zip.finalize();
  });
  return true;
}

function useSystemZip() {
  const { execFileSync } = require('child_process');
  const args = ['-r', '-9', out, '.', '-x'];
  args.push('.DS_Store', '*/.DS_Store', 'CLAUDE.md', 'TESTING.md');
  execFileSync('zip', args, { cwd: src, stdio: ['ignore', 'inherit', 'inherit'] });
}

(async () => {
  try {
    const ok = await useArchiver();
    if (!ok) {
      console.log('archiver not found, falling back to system zip');
      useSystemZip();
    }
  } catch (e) {
    console.error('❌ zip failed:', e.message);
    process.exit(1);
  }
  const size = fs.statSync(out).size;
  console.log('✅ extension zip:', size, 'bytes ->', out);
})();
