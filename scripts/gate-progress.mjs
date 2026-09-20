import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/** Partial reporter output is diagnostic only, never evidence of a suite PASS.
 * Allowlist existing test paths and numbers; discard titles, errors and values. */
export function partialTestProgress(log, root) {
  const files = [];
  let truncated = false;
  for (const line of stripVTControlCharacters(log).replaceAll('\\', '/').split('\n')) {
    const match = /^\s*[✓√✔×❯↓]\s+(tests\/(?:unit|integration|security|compatibility|packaging)\/[A-Za-z0-9_/-]+\.test\.ts)\s+\((\d+) tests?((?: \| \d+ (?:failed|skipped|todo))*)\)\s+(\d+)ms\s*$/.exec(line);
    if (!match || !fs.existsSync(path.join(root, match[1]))) continue;
    if (files.length >= 200) { truncated = true; continue; }
    const total = Number(match[2]), durationMs = Number(match[4]);
    const counts = { failed: 0, skipped: 0, todo: 0 };
    for (const item of match[3].matchAll(/(\d+) (failed|skipped|todo)/g)) counts[item[2]] = Number(item[1]);
    if (![total, durationMs, ...Object.values(counts)].every(Number.isSafeInteger)
      || Object.values(counts).reduce((sum, count) => sum + count, 0) > total) continue;
    files.push({ file: match[1], total, ...counts, durationMs });
  }
  return { complete: false, files, truncated };
}
