// Prints a per-file pass/fail table from a vitest JSON report (for docs/TEST_REPORT.md).
// Usage: npx vitest run --reporter=json --outputFile=/tmp/r.json && node scripts/test-report.mjs /tmp/r.json
import fs from 'node:fs';
const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/test-report.mjs <vitest-json>');
  process.exit(2);
}
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
let pass = 0;
let fail = 0;
const rows = [];
for (const f of r.testResults) {
  const short = f.name.split('/tests/')[1] ?? f.name;
  let p = 0;
  let x = 0;
  for (const a of f.assertionResults) {
    if (a.status === 'passed') p += 1;
    else x += 1;
  }
  pass += p;
  fail += x;
  rows.push([short, p, x]);
}
rows.sort((a, b) => a[0].localeCompare(b[0]));
for (const [name, p, x] of rows) console.log(`${String(p).padStart(3)}/${String(p + x).padEnd(4)} ${name}${x ? '  ← FAIL' : ''}`);
console.log(`TOTAL ${pass}/${pass + fail}${fail ? `  (${fail} failing)` : ''}`);
process.exit(fail ? 1 : 0);
