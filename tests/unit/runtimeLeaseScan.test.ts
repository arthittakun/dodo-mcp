import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveStateRuntimePids } from '../../src/config/stateCheckpoint.js';

describe('installation runtime lease scan', () => {
  const prefix = path.join(fs.realpathSync.native(os.tmpdir()), 'dodo-runtime-lease-scan-');
  const name = `${'a'.repeat(64)}.json`;
  let configDir: string;
  let directory: string;
  let file: string;

  beforeEach(() => {
    configDir = fs.mkdtempSync(prefix);
    directory = path.join(configDir, 'runtime-leases');
    file = path.join(directory, name);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (!path.resolve(configDir).startsWith(prefix)) throw new Error('unsafe lease fixture cleanup');
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function writeLease(contents: string): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, contents, { mode: 0o600 });
  }

  it('accepts an absent lease directory and excludes the current PID only when requested', () => {
    expect(liveStateRuntimePids(configDir)).toEqual([]);
    writeLease(JSON.stringify({ pid: process.pid, nonce: 'private-lease-nonce' }));
    expect(liveStateRuntimePids(configDir)).toEqual([]);
    expect(liveStateRuntimePids(configDir, true)).toEqual([process.pid]);
  });

  it('handles a lease that disappears after its filename is listed', () => {
    writeLease(JSON.stringify({ pid: process.pid }));
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((item, flags, mode) => {
      if (item === file) fs.unlinkSync(file);
      return open(item, flags, mode);
    });
    expect(liveStateRuntimePids(configDir, true)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each(['ENOENT', 'EACCES', 'private-code'])('fails closed when a lease still exists after %s and retains the cause', code => {
    writeLease(JSON.stringify({ pid: process.pid }));
    const cause = Object.assign(new Error(`private path detail ${configDir}`), { code });
    const reason = code === 'private-code' ? 'LEASE_READ_FAILED' : code;
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((item, flags, mode) => {
      if (item === file) throw cause;
      return open(item, flags, mode);
    });
    expect(() => liveStateRuntimePids(configDir)).toThrow(expect.objectContaining({
      code: 'CONFLICT',
      cause,
      message: `cannot establish whether an installation runtime is still using state (${reason} in ${name})`,
      detail: { entry: name, reason },
    }));
  });

  it('reports invalid JSON without including lease contents', () => {
    writeLease('private-lease-contents');
    expect(() => liveStateRuntimePids(configDir)).toThrow(expect.objectContaining({
      code: 'CONFLICT',
      cause: expect.any(SyntaxError),
      message: `cannot establish whether an installation runtime is still using state (INVALID_JSON in ${name})`,
      detail: { entry: name, reason: 'INVALID_JSON' },
    }));
  });

  it.each(['null', '[]', '{}', '{"pid":"123"}', '{"pid":0}', '{"pid":-1}', '{"pid":0.5}', '{"pid":2147483648}'])('rejects invalid lease data %s before probing a process', contents => {
    writeLease(contents);
    const probe = vi.spyOn(process, 'kill');
    expect(() => liveStateRuntimePids(configDir)).toThrow(expect.objectContaining({
      code: 'CONFLICT',
      message: `invalid runtime lease prevents an offline state operation (INVALID_PID in ${name})`,
      detail: { entry: name, reason: 'INVALID_PID' },
    }));
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps file identity checks for a hard-linked lease', () => {
    writeLease(JSON.stringify({ pid: process.pid }));
    fs.linkSync(file, path.join(directory, 'alias'));
    expect(() => liveStateRuntimePids(configDir)).toThrow(expect.objectContaining({
      code: 'CONFLICT',
      cause: expect.objectContaining({ code: 'PATH_DENIED' }),
      detail: { entry: name, reason: 'PATH_DENIED' },
    }));
  });
});
