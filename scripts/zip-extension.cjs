const fs = require('fs');
let archiver;
try {
  archiver = require('archiver');
} catch (e) {
  archiver = require(require('path').join(process.env.NODE_PATH || '/usr/local/lib/node_modules', 'archiver'));
}

const src = process.env.SRC || '/app/extension';
const out = process.env.OUT || '/app/web/dist/downloads/marksync-extension-latest.zip';

const output = fs.createWriteStream(out);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => console.log('✅ extension zip:', archive.pointer(), 'bytes ->', out));
archive.on('warning', w => console.warn('warn:', w));
archive.on('error', e => { throw e; });

archive.pipe(output);
archive.glob('**/*', {
  cwd: src,
  ignore: ['**/.DS_Store', 'docs/**', 'CLAUDE.md', 'TESTING.md']
});
archive.finalize();
