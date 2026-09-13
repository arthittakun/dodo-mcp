import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GlobalConfigSchema, loadGlobalConfig, saveGlobalConfig } from '../../src/config/globalConfig.js';
import { INPUT_LIMIT_PROFILES, LimitsSchema } from '../../src/config/limits.js';
import { validateExecArgs, validateShellCommand } from '../../src/services/jobs/commandInput.js';

const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));

describe('local input limits', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-input-limits-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = (args: string[], configDir = dir) => spawnSync(process.execPath, [CLI, 'limits', ...args], { cwd: os.homedir(), env: { ...process.env, DODO_CONFIG_DIR: configDir }, encoding: 'utf8' });

  it('profiles preserve all non-input settings; read-only query does not create config or state', () => {
    const missing = path.join(dir, 'absent');
    expect(cli(['--json'], missing).status).toBe(0);
    expect(fs.existsSync(missing)).toBe(false);
    const file = path.join(dir, 'config.json');
    const before = GlobalConfigSchema.parse({ publicUrl: 'https://owner.example', commandSandbox: 'require', secretDeny: ['private/**'], limits: { jobsConcurrentMax: 2, toolContentBytes: 12345, readFileBytes: 1048576 } });
    saveGlobalConfig(file, before);
    const result = cli(['--profile', 'large', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).restartRequired).toBe(true);
    const after = loadGlobalConfig(file);
    expect(after).toEqual({ ...before, limits: { ...before.limits, ...INPUT_LIMIT_PROFILES.large } });
    expect(fs.existsSync(path.join(dir, 'state.db'))).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(cli(['--profile', 'standard']).status).toBe(0);
    expect(loadGlobalConfig(file).limits).toEqual({ ...before.limits, ...INPUT_LIMIT_PROFILES.standard });
  });

  it('unlimited/invalid profiles and corrupt config fail without overwriting', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{broken');
    for (const profile of ['large', 'unlimited', '../x']) expect(cli(['--profile', profile]).status).not.toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
    for (const commandBytes of [0, -1, Infinity, 8 * 1024 * 1024 + 1]) expect(LimitsSchema.safeParse({ commandBytes }).success).toBe(false);
  });

  it('native argv guards use bytes, cap combined size and reject NUL, while long shell source has its own budget', () => {
    expect(() => validateExecArgs('node', ['-e', 'x'.repeat(60000)])).not.toThrow();
    expect(() => validateExecArgs('node', ['ก'.repeat(22000)])).toThrow(/one argument/);
    expect(() => validateExecArgs('node', ['x'.repeat(50000), 'y'.repeat(50000), 'z'.repeat(50000)])).toThrow(/combined/);
    expect(() => validateExecArgs('node', ['bad\0'])).toThrow(/NUL/);
    expect(() => validateShellCommand('ก'.repeat(3000), 8192)).toThrow(/UTF-8 bytes/);
    expect(() => validateShellCommand('x'.repeat(8 * 1024 * 1024), INPUT_LIMIT_PROFILES.large.commandBytes)).not.toThrow();
  });
});
