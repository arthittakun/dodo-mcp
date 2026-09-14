// Copies the Local Config UI (plain HTML/CSS/JS, no build step) next to the
// compiled server so `dist/` — and therefore the npm tarball — is self-contained.
// Walks one level of subdirectories (ui/, vendor/) with a strict extension
// allowlist; nothing outside src/server/configUi is ever included.
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('src/server/configUi');
const dst = path.resolve('dist/server/configUi');
const ALLOWED = /\.(html|css|js|svg|txt)$/;

let n = 0;
function copyDir(from, to, depth) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (depth < 1) copyDir(path.join(from, entry.name), path.join(to, entry.name), depth + 1);
      continue;
    }
    if (!entry.isFile() || !ALLOWED.test(entry.name)) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    n += 1;
  }
}
copyDir(src, dst, 0);
console.log(`[dodo] copied ${n} Local Config UI asset(s) to ${path.relative(process.cwd(), dst)}/`);
