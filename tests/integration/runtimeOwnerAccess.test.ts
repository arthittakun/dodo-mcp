import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { launch, mkTmpDir } from '../helpers/testServer.js';
import { installationIpcCall } from '../../src/ipc/installationClient.js';
import { assertPrivatePath } from '../../src/platform/privateFs.js';
import { DODO_VERSION } from '../../src/server/version.js';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const state = (url: string) => { const target = new URL(url); return fetch(`${target.origin}/api/state`, { headers: { authorization: `Bearer ${target.hash.slice(1)}` } }); };

describe('private owner access and runtime identity', () => {
  it.each([true, false])('startup logs never contain the local capability (quiet=%s)', async quiet => {
    const lines: string[] = [];
    const ctx = await launch({ deferWorkspace: true, configPort: 0, quiet, onLog: line => lines.push(line) });
    try {
      const original = ctx.configUrl!, secret = new URL(original).hash.slice(1);
      expect(lines.join('\n')).not.toContain(secret);
      expect(lines.join('\n')).not.toMatch(/\/#(?:[a-f0-9]{64})/);
      expect(lines.join('\n')).toContain(`serverVersion=${DODO_VERSION}`);
      const renewed = await installationIpcCall(ctx.configDir, 'localConfig.open') as { url: string; expiresAt: number };
      expect(renewed.url).not.toBe(original);
      expect((await state(original)).status).toBe(401);
      expect((await state(renewed.url)).status).toBe(200);
      expect(lines.join('\n')).not.toContain(new URL(renewed.url).hash.slice(1));
    } finally { await ctx.cleanup(); }
  });

  it('refuses redirected secrets, writes an explicitly requested private file and locates launcher status from any CWD', async () => {
    const lines: string[] = [];
    const ctx = await launch({ deferWorkspace: true, configPort: 0, onLog: line => lines.push(line) });
    const cwd = mkTmpDir('dodo-owner-status-');
    const options = { cwd, env: { ...process.env, DODO_CONFIG_DIR: ctx.configDir }, windowsHide: true, timeout: 30000 };
    try {
      await expect(execute(process.execPath, [CLI, 'web', '--local'], options)).rejects.toMatchObject({ stderr: expect.stringContaining('redirected output') });
      expect((await state(ctx.configUrl!)).status).toBe(200);
      const existing = path.join(cwd, 'existing.json'); fs.writeFileSync(existing, '{}');
      await expect(execute(process.execPath, [CLI, 'web', '--local', '--output-file', existing], options)).rejects.toMatchObject({ stderr: expect.stringContaining('already exists') });
      expect((await state(ctx.configUrl!)).status).toBe(200);
      const outputFile = path.join(cwd, 'owner-access.json');
      const result = await execute(process.execPath, [CLI, 'web', '--local', '--output-file', process.platform === 'win32' ? outputFile.toLowerCase() : outputFile], options);
      const access = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as { url: string };
      expect(result.stdout).not.toContain(new URL(access.url).hash.slice(1));
      expect(result.stderr).not.toContain(new URL(access.url).hash.slice(1));
      expect((await state(access.url)).status).toBe(200);
      expect((await state(ctx.configUrl!)).status).toBe(401);
      expect(assertPrivatePath(outputFile).isFile()).toBe(true);
      const inspected = JSON.parse((await execute(process.execPath, [CLI, 'status', '--json'], options)).stdout) as Record<string, unknown>;
      expect(inspected).toMatchObject({ version: DODO_VERSION, serverVersion: DODO_VERSION, cliVersion: DODO_VERSION, versionMismatch: false });
      expect(path.isAbsolute(String(inspected.nodeExecutable))).toBe(true);
      expect(path.isAbsolute(String(inspected.entryPoint))).toBe(true);
      expect(lines.join('\n')).not.toContain(new URL(access.url).hash.slice(1));
    } finally { await ctx.cleanup(); }
  });

  it('doctor does not create or migrate installation state while diagnosing a fresh directory', async () => {
    const cwd = mkTmpDir('dodo-readonly-doctor-'), configDir = path.join(cwd, 'absent-config');
    await execute(process.execPath, [CLI, 'doctor', '--json'], { cwd, env: { ...process.env, DODO_CONFIG_DIR: configDir }, windowsHide: true, timeout: 30000 }).catch(() => undefined);
    expect(fs.existsSync(configDir)).toBe(false);
  });
});
