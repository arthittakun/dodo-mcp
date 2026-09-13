// Refuses `npm publish` until the owner replaces the placeholder scope.
// DODO must never be published to a namespace the owner has not verified.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (pkg.name.startsWith('@your-scope/')) {
  console.error(
    '[dodo] refusing to publish: package name still uses the placeholder scope "@your-scope".\n' +
      'Rename the package to a scope you own (see README "Publishing"), then publish manually.',
  );
  process.exit(1);
}
