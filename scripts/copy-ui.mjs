// Copies the Local Config UI (plain HTML/CSS/JS, no build step) next to the
// compiled server so `dist/` — and therefore the npm tarball — is self-contained.
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('src/server/configUi');
const dst = path.resolve('dist/server/configUi');
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (!/\.(html|css|js|svg)$/.test(f)) continue;
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  n += 1;
}
console.log(`[dodo] copied ${n} Local Config UI asset(s) to ${path.relative(process.cwd(), dst)}/`);
