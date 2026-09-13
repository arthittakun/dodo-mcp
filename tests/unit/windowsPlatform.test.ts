import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLocalWindowsRoot, assertWindowsSegment, isWithinPath } from '../../src/platform/pathPolicy.js';
import { executableNames, resolveTrustedExecutable } from '../../src/platform/execResolve.js';
import { assertWindowsArgv, quoteBatchArgument, shellInvocation, windowsCommandLineLength } from '../../src/platform/shell.js';
import { envValue, windowsProgramDataDirectory, windowsSystemExecutable } from '../../src/platform/system.js';
import { retryWindowsFs } from '../../src/platform/fsRetry.js';
import { buildChildEnv, trustedPath } from '../../src/security/env.js';
import { decodeUtf8Strict } from '../../src/util/bytes.js';
import { ipcTransportPath, ipcMac, validMac } from '../../src/ipc/authentication.js';
import { parseWindowsSandboxStatus } from '../../src/platform/windowsSandbox.js';
import { RUNTIME_ACL_VERIFY, sandboxRuntimeAclArgs } from '../../src/setup/windowsSandboxInstall.js';

describe('Windows platform contracts (pure tests run on every OS)', () => {
  it('uses drive-aware, case-insensitive, segment-aware containment', () => {
    expect(isWithinPath('C:\\Project', 'c:\\PROJECT\\src\\file.ts', 'win32')).toBe(true);
    expect(isWithinPath('C:\\Project', 'C:\\Project-other\\file.ts', 'win32')).toBe(false);
    expect(isWithinPath('C:\\Project', 'D:\\Project\\file.ts', 'win32')).toBe(false);
    expect(isWithinPath('/work', '/work/..notes', 'linux')).toBe(true);
  });
  it.each(['CON', 'con.txt', 'NUL.json', 'aux', 'COM1.log', 'LPT9', 'COM¹.txt', 'CONOUT$', 'foo:stream', 'file.', 'file ', 'PROGRA~1', 'a?b', 'a\u0001b'])('rejects ambiguous/device/ADS path %j', segment => {
    expect(() => assertWindowsSegment(segment)).toThrow();
  });
  it('accepts ordinary Unicode and spaces; refuses UNC/device namespaces', () => {
    expect(() => assertWindowsSegment('โปรเจ็ค งาน.ts')).not.toThrow();
    expect(() => assertWindowsSegment('console.ts')).not.toThrow();
    expect(() => assertLocalWindowsRoot('C:\\Users\\owner\\โปรเจ็ค space')).not.toThrow();
    for (const root of ['\\\\server\\share', '\\\\?\\C:\\work', '\\\\.\\pipe\\x']) expect(() => assertLocalWindowsRoot(root)).toThrow();
  });
  it('normalizes Windows environment keys without forwarding loader/owner secrets', () => {
    const env = buildChildEnv({ platform: 'win32', workspaceRoot: 'C:\\Project', extraAllowlist: ['PATH', 'Node_Options', 'DODO_TOKEN'], parentEnv: { Path: '.;C:\\PROJECT;C:\\Tools', SystemRoot: 'C:\\Windows', LocalAppData: 'C:\\Users\\owner\\AppData\\Local', ProgramData: 'C:\\ProgramData', PATHEXT: '.EXE;.CMD;.PS1', Node_Options: '--require evil', DODO_TOKEN: 'secret', COMSPEC: 'C:\\Project\\cmd.exe' } });
    expect(env['PATH']).toBe('C:\\Tools');
    expect(env['SYSTEMROOT']).toBe('C:\\Windows');
    expect(env['LOCALAPPDATA']).toContain('AppData');
    expect(env['PROGRAMDATA']).toBe('C:\\ProgramData');
    expect(env['PATHEXT']).toBe('.EXE;.CMD');
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['DODO_TOKEN']).toBeUndefined();
    expect(env['COMSPEC']).toBeUndefined();
    expect(envValue({ Path: 'b', PATH: 'a' }, 'path', 'win32')).toBe('a');
  });
  it('recovers local ProgramData from trusted Windows roots when an older parent stripped it', () => {
    expect(windowsProgramDataDirectory({ ProgramData: 'C:\\ProgramData\\' })).toBe('C:\\ProgramData\\');
    expect(windowsProgramDataDirectory({ SystemDrive: 'D:' })).toBe('D:\\ProgramData');
    expect(windowsProgramDataDirectory({ SystemRoot: 'E:\\Windows' })).toBe('E:\\ProgramData');
    expect(windowsProgramDataDirectory({ ProgramData: '\\\\server\\share', SystemDrive: 'F:' })).toBe('F:\\ProgramData');
    expect(windowsProgramDataDirectory({ ProgramData: 'relative' })).toBeUndefined();
    const env = buildChildEnv({ platform: 'win32', workspaceRoot: 'C:\\Project', extraAllowlist: [], parentEnv: { Path: 'C:\\Tools', SystemDrive: 'C:', SystemRoot: 'C:\\Windows' } });
    expect(env['PROGRAMDATA']).toBe('C:\\ProgramData');
  });
  it('parses pinned srt-win raw status and fails closed on inconsistent provisioning identity', () => {
    const sid = 'S-1-5-21-1-2-3-1001';
    const raw = { user: { cred_present: true, marker_version: 2, marker_user_sid: sid, user: { exists: true, group_exists: true, in_builtin_users: true, in_sandbox_group: true, hidden_from_logon: true, sid } }, wfp: { state: 'installed', user_sid: sid } };
    expect(parseWindowsSandboxStatus(raw)).toEqual({ provisioned: true, fence: 'installed' });
    expect(parseWindowsSandboxStatus({ ...raw, user: { ...raw.user, cred_present: false } })?.provisioned).toBe(false);
    expect(parseWindowsSandboxStatus({ ...raw, user: { ...raw.user, marker_user_sid: 'S-1-5-21-1-2-3-9999' } })?.provisioned).toBe(false);
    expect(parseWindowsSandboxStatus({ ...raw, wfp: { state: 'installed', user_sid: 'S-1-5-21-1-2-3-9999' } })?.provisioned).toBe(false);
    expect(parseWindowsSandboxStatus({ ...raw, wfp: { state: 'unknown' } })).toBeUndefined();
  });
  it('grants the sandbox runtime group read/execute only, never write authority', () => {
    const sid = 'S-1-5-21-1-2-3-1000';
    expect(sandboxRuntimeAclArgs('C:\\state\\runtime', sid)).toEqual(['C:\\state\\runtime', '/grant', `*${sid}:(OI)(CI)(RX)`, '/T', '/C', '/Q']);
    expect(() => sandboxRuntimeAclArgs('C:\\state\\runtime', 'sandbox-runtime-users')).toThrow();
    expect(RUNTIME_ACL_VERIFY).toContain('::ReadAndExecute');
    expect(RUNTIME_ACL_VERIFY).toContain('::WriteData');
    expect(RUNTIME_ACL_VERIFY).not.toContain('::FullControl');
    expect(RUNTIME_ACL_VERIFY).not.toContain('::Modify');
  });
  it('filters Windows PATH using semicolons and does not confuse prefix siblings', () => {
    expect(trustedPath(';relative;C:\\project;C:\\project\\bin;C:\\project2;C:\\Tools', 'c:\\PROJECT', 'win32')).toBe('C:\\project2;C:\\Tools');
  });
  it('resolves PATHEXT only for allowed formats and never path-like bare names', () => {
    expect(executableNames('node', '.EXE;.CMD;.PS1', 'win32')).toEqual(['node.EXE', 'node.CMD']);
    expect(executableNames('npm.cmd', undefined, 'win32', false)).toEqual([]);
    expect(executableNames('pyright.ps1', undefined, 'win32')).toEqual([]);
    expect(() => executableNames('../git', undefined, 'win32')).toThrow();
  });
  it('rejects shell metacharacters rather than guessing batch argv quoting', () => {
    expect(quoteBatchArgument('ไทย space')).toBe('"ไทย space"');
    for (const argument of ['a&b', 'a|b', '%PATH%', '!NAME!', '"quoted"', 'a\nb', '(x)']) expect(() => quoteBatchArgument(argument)).toThrow();
    const invocation = shellInvocation({ kind: 'cmd', executable: 'C:\\Windows\\System32\\cmd.exe', extension: '.cmd' }, 'echo hello', 'C:\\Users\\owner\\space dir\\command.cmd');
    expect(invocation.args.slice(0, 4)).toEqual(['/d', '/s', '/v:off', '/c']);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });
  it('bounds the native command line in UTF-16 units, not just UTF-8 bytes', () => {
    expect(windowsCommandLineLength('n', [''])).toBe(5);
    expect(() => assertWindowsArgv('node.exe', ['ไทย', 'emoji 😀', 'C:\\space dir\\'])).not.toThrow();
    expect(() => assertWindowsArgv('node.exe', ['😀'.repeat(16400)])).toThrow(/32767/);
    expect(() => assertWindowsArgv('node.exe', ['a\0b'])).toThrow(/NUL/);
  });
  it('uses fixed Windows system utility paths, never COMSPEC/PATH', () => {
    expect(windowsSystemExecutable('cmd.exe', { SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\repo\\evil.exe' })).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(() => windowsSystemExecutable('cmd.exe', { SystemRoot: 'relative' })).toThrow();
  });
  it('retries only bounded transient Windows failures', () => {
    let calls = 0;
    expect(retryWindowsFs(() => { if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return 'done'; }, 'win32')).toBe('done');
    expect(calls).toBe(3);
    calls = 0;
    expect(() => retryWindowsFs(() => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, 'linux')).toThrow();
    expect(calls).toBe(1);
  });
  it('preserves UTF-8 BOM and CRLF byte-for-byte', () => {
    const raw = Buffer.from('\uFEFFไทย\r\nsecond\r\n', 'utf8');
    expect(Buffer.from(decodeUtf8Strict(raw)!, 'utf8')).toEqual(raw);
  });
  it('names pipes by config plus listener generation, not just workspace name', () => {
    const a = ipcTransportPath('C:\\StateA\\ipc\\abc.sock', 'a'.repeat(32), 'win32');
    expect(a.startsWith('\\\\.\\pipe\\dodo-')).toBe(true);
    expect(a).not.toBe(ipcTransportPath('C:\\StateB\\ipc\\abc.sock', 'a'.repeat(32), 'win32'));
    expect(a).not.toBe(ipcTransportPath('C:\\StateA\\ipc\\abc.sock', 'b'.repeat(32), 'win32'));
  });
  it('binds IPC proofs to direction, nonce pair and exact payload', () => {
    const token = 'f'.repeat(64), mac = ipcMac(token, 'request', 'client', 'server', 'payload');
    expect(validMac(mac, ipcMac(token, 'request', 'client', 'server', 'payload'))).toBe(true);
    expect(validMac(mac, ipcMac(token, 'response', 'client', 'server', 'payload'))).toBe(false);
    expect(validMac(mac, ipcMac(token, 'request', 'client', 'other', 'payload'))).toBe(false);
    expect(validMac('short', mac)).toBe(false);
  });
  it('refuses a repository executable even when explicitly added to PATH', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-resolve-')));
    try {
      const name = process.platform === 'win32' ? 'fake-helper.exe' : 'fake-helper';
      fs.writeFileSync(path.join(root, name), 'not a trusted helper', { mode: 0o755 });
      expect(() => resolveTrustedExecutable('fake-helper', root, { env: { PATH: root, PATHEXT: '.EXE' } })).toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
