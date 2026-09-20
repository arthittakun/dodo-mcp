import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { failureLocations } from './gate-evidence.mjs';

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

/** Match only codes already declared in public source and repository locations.
 * This lets a focused run diagnose failures without publishing error messages. */
export function focusedFailureDetails(report, root) {
  const codes = new Set([...fs.readFileSync(path.join(root, 'src/errors.ts'), 'utf8').matchAll(/^  '([A-Z_]+)',?$/gm)].map(m => m[1]));
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EINVAL', 'ETIMEDOUT', 'ENOSPC', 'BACKUP_IO_ERROR']) codes.add(code);
  const allowed = failureLocations(report, root);
  const locations = allowed.locations.map(location => {
    const file = report.testResults.find(item => path.relative(root, item.name).replaceAll('\\', '/') === location.file);
    const assertion = location.assertionIndex === null ? null : file.assertionResults[location.assertionIndex];
    const message = (assertion?.failureMessages ?? []).filter(v => typeof v === 'string').join('\n').replaceAll('\\', '/');
    const frames = [];
    for (const frame of message.matchAll(/((?:src|tests|scripts)\/[A-Za-z0-9_/-]+\.(?:ts|mjs)):(\d+):\d+/g)) {
      if (frames.length === 8) break;
      if (fs.existsSync(path.join(root, frame[1]))) frames.push({ file: frame[1], line: Number(frame[2]) });
    }
    const errorCodes = [...new Set([...message.matchAll(/\b[A-Z][A-Z_]{2,63}\b/g)].map(m => m[0]).filter(code => codes.has(code)))];
    return { ...location, errorCodes, frames };
  });
  return { locations, truncated: allowed.truncated };
}
