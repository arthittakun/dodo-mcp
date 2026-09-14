// Copies the pinned SweetAlert2 dist assets from node_modules into the
// Local Config UI vendor directory. Same-origin only: the UI never loads
// anything from a CDN (CSP script-src/style-src 'self'). Run via `npm run build`.
import fs from 'node:fs';
import path from 'node:path';

const pkg = path.resolve('node_modules/sweetalert2');
const dst = path.resolve('src/server/configUi/vendor');
const files = ['sweetalert2.min.js', 'sweetalert2.min.css'];

if (!fs.existsSync(pkg)) {
  // A packed tarball consumer never runs this; devs need the pinned devDependency.
  if (files.every((f) => fs.existsSync(path.join(dst, f)))) {
    console.log('[dodo] vendor-ui: node_modules/sweetalert2 missing; keeping existing vendored assets');
    process.exit(0);
  }
  console.error('[dodo] vendor-ui: sweetalert2 is not installed and no vendored copy exists — run `npm install` first');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
fs.mkdirSync(dst, { recursive: true });
for (const f of files) {
  fs.copyFileSync(path.join(pkg, 'dist', f), path.join(dst, f));
}
fs.writeFileSync(path.join(dst, 'VERSION.txt'), `sweetalert2 ${version} (MIT) — vendored by scripts/vendor-ui.mjs; do not edit by hand\n`);
console.log(`[dodo] vendor-ui: vendored sweetalert2 ${version} into src/server/configUi/vendor/`);
