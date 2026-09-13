import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyConfigDirs, resolveConfigDir } from '../../src/config/paths.js';

describe('Dodo config namespace', () => {
  it('uses DODO_CONFIG_DIR when explicitly configured', () => {
    const resolved = resolveConfigDir({ DODO_CONFIG_DIR: '/tmp/dodo-state' });
    expect(resolved.dir).toBe(path.resolve('/tmp/dodo-state'));
    expect(resolved.source).toBe('env');
    expect(resolved.envVar).toBe('DODO_CONFIG_DIR');
    expect(resolved.legacy).toBeUndefined();
  });

  it('only returns fixed legacy locations for migration inspection', () => {
    const candidates = legacyConfigDirs();
    expect(candidates.length).toBeGreaterThan(0);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.every(candidate => path.isAbsolute(candidate))).toBe(true);
    expect(candidates.some(candidate => candidate.endsWith(`${path.sep}dodo`))).toBe(true);
    expect(candidates.some(candidate => candidate.includes(os.homedir()))).toBe(true);
  });
});
