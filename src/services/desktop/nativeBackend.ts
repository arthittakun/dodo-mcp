import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DodoError, type ErrorCode } from '../../errors.js';
import type { DesktopBackend } from './protocol.js';
import { ensurePrivateDirectory } from '../../platform/privateFs.js';
import { assertSetupPrivatePaths } from '../../setup/managedTools.js';
import { buildChildEnv } from '../../security/env.js';
import { envValue } from '../../platform/system.js';
import { renameWithRetry } from '../../platform/fsRetry.js';
import { resolveTrustedExecutable } from '../../platform/execResolve.js';
const sourceFile = fileURLToPath(new URL(process.platform === 'win32' ? '../../../native/desktop-windows.cs' : process.platform === 'linux' ? '../../../native/desktop-linux.py' : '../../../native/desktop.swift', import.meta.url));
// Source and dist have identical depth below the package root.
export function nativeHelperPath(configDir: string): string {
    const hash = createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex').slice(0, 20);
    return path.join(configDir, 'native', `dodo-desktop-${process.arch}-${hash}${process.platform === 'win32' ? '.exe' : process.platform === 'linux' ? '.py' : ''}`);
}
const minimalEnv = (): NodeJS.ProcessEnv => {
    if (process.platform === 'win32') return buildChildEnv({ parentEnv: process.env, workspaceRoot: os.tmpdir(), extraAllowlist: [] });
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: os.tmpdir() };
    if (process.platform === 'linux') {
        // Owner session environment, never supplied by the MCP request or project configuration.
        for (const name of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LANG']) {
            const value = process.env[name]; if (value !== undefined && !value.includes('\0')) env[name] = value;
        }
    }
    return env;
};

/** Isolated Python: no cwd imports, PYTHONPATH, sitecustomize in the project, or shell. */
function linuxInterpreter(): string {
    const candidates = ['/usr/bin/python3'];
    try { candidates.push(resolveTrustedExecutable('python3', process.cwd(), { allowBatch: false })); } catch { /* system path is still checked */ }
    for (const program of new Set(candidates)) {
        if (!fs.existsSync(program)) continue;
        const result = spawnSync(program, ['-I', '-c', 'import Xlib.display; import Xlib.ext.xtest; import PIL.Image; import ctypes.util; assert ctypes.util.find_library("atspi")'], { cwd: os.tmpdir(), env: minimalEnv(), shell: false, timeout: 5000, maxBuffer: 16384 });
        if (!result.error && result.status === 0) return program;
    }
    throw new DodoError('NOT_SUPPORTED', 'Linux desktop needs Python 3, python-xlib, Pillow and AT-SPI; run dodo setup --components desktop');
}

/** Inbox .NET Framework compiler, never a repository/PATH-provided executable. */
function windowsCompiler(): { program: string; refs: string[] } {
    const systemRoot = envValue(process.env, 'SystemRoot');
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new DodoError('NOT_SUPPORTED', 'valid Windows SystemRoot is required');
    for (const framework of ['Framework64', 'Framework']) {
        const dir = path.join(systemRoot, 'Microsoft.NET', framework, 'v4.0.30319');
        const program = path.join(dir, 'csc.exe');
        const refs = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map(name => path.join(dir, 'WPF', name));
        if ([program, ...refs].every(p => fs.existsSync(p) && fs.statSync(p).isFile())) return { program, refs };
    }
    throw new DodoError('NOT_SUPPORTED', 'Windows desktop setup requires .NET Framework 4.8 desktop assemblies and an interactive session');
}
async function processOutput(program: string, args: string[], input: string, timeout: number, cap: number): Promise<{
    code: number | null;
    stdout: string;
}> {
    return new Promise((resolve, reject) => {
        const child = spawn(program, args, { shell: false, windowsHide: true, cwd: os.tmpdir(), env: minimalEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let size = 0, failed = false;
        const stop = (message: string) => { if (failed)
            return; failed = true; child.kill('SIGKILL'); reject(new DodoError('RESOURCE_LIMIT', message)); };
        const timer = setTimeout(() => stop('desktop helper timed out; action outcome may be uncertain, capture again'), timeout);
        child.stdout.on('data', (data: Buffer) => { size += data.length; if (size > cap)
            stop('desktop helper output exceeds limit');
        else
            chunks.push(data); });
        // Drain, but never include unbounded native/compiler diagnostics or sensitive OS data in a remote error.
        child.stderr.resume();
        child.stdin.on('error', () => undefined);
        child.on('error', () => { clearTimeout(timer); failed = true; reject(new DodoError('NOT_SUPPORTED', 'desktop helper could not start')); });
        child.on('close', (code) => { clearTimeout(timer); if (!failed)
            resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }); });
        child.stdin.end(input);
    });
}
export async function setupNativeDesktop(configDir: string, requestPermissions = false): Promise<{
    helper: string;
    permissions: unknown;
}> {
    if (!['darwin', 'win32', 'linux'].includes(process.platform))
        throw new DodoError('NOT_SUPPORTED', 'no native desktop adapter is packaged for this platform');
    if (process.platform === 'linux') linuxInterpreter();
    const helper = nativeHelperPath(configDir);
    ensurePrivateDirectory(path.dirname(helper));
    if (!fs.existsSync(helper)) {
        const temporary = `${helper}.${process.pid}.tmp`;
        try {
            if (process.platform === 'linux') fs.copyFileSync(sourceFile, temporary, fs.constants.COPYFILE_EXCL);
            else {
                const compiler = process.platform === 'win32' ? windowsCompiler() : undefined;
                const built = compiler
                    ? await processOutput(compiler.program, ['/nologo', '/target:exe', '/optimize+', `/out:${temporary}`, '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', ...compiler.refs.map(ref => `/r:${ref}`), sourceFile], '', 120000, 1024 * 1024)
                    : await processOutput('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', sourceFile, '-o', temporary], '', 120000, 1024 * 1024);
                if (built.code !== 0) throw new DodoError('NOT_SUPPORTED', compiler ? 'Windows desktop helper compilation failed; verify .NET Framework desktop assemblies' : 'Swift helper compilation failed; install Xcode Command Line Tools and use macOS 14+');
            }
            if (process.platform !== 'win32') fs.chmodSync(temporary, 0o700);
            renameWithRetry(temporary, helper);
        }
        finally {
            try {
                fs.unlinkSync(temporary);
            }
            catch { /* absent after rename */ }
        }
    }
    const backend = new NativeDesktopBackend(configDir);
    return { helper, permissions: await backend.run({ op: requestPermissions ? 'requestPermissions' : 'status' }) };
}
export class NativeDesktopBackend implements DesktopBackend {
    constructor(private readonly configDir: string) { }
    available(): boolean {
        if (!['darwin', 'win32', 'linux'].includes(process.platform))
            return false;
        try {
            const helper = nativeHelperPath(this.configDir);
            if (process.platform === 'win32' || process.platform === 'linux') assertSetupPrivatePaths([path.dirname(helper), helper]);
            if (process.platform === 'linux') linuxInterpreter();
            const st = fs.lstatSync(helper);
            return st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && (process.platform === 'win32' || (st.mode & 0o077) === 0);
        }
        catch {
            return false;
        }
    }
    async run(request: Record<string, unknown>): Promise<unknown> {
        if (!this.available())
            throw new DodoError('NOT_SUPPORTED', 'desktop helper is not installed or not private; run dodo setup --components desktop in the local interactive user session');
        const input = JSON.stringify(request);
        if (Buffer.byteLength(input) > 64 * 1024)
            throw new DodoError('RESOURCE_LIMIT', 'desktop input exceeds limit');
        const helper = nativeHelperPath(this.configDir);
        const result = await processOutput(process.platform === 'linux' ? linuxInterpreter() : helper, process.platform === 'linux' ? ['-I', helper] : [], input, request['op'] === 'requestPermissions' ? 60000 : 15000, 5 * 1024 * 1024);
        let response: {
            ok?: boolean;
            data?: unknown;
            error?: {
                code?: string;
                message?: string;
            };
        };
        try {
            response = JSON.parse(result.stdout) as typeof response;
        }
        catch {
            throw new DodoError('INTERNAL_ERROR', 'desktop helper returned invalid output');
        }
        if (!response.ok || result.code !== 0) {
            const allowed: ErrorCode[] = ['INVALID_INPUT', 'FORBIDDEN', 'STALE_WORKSPACE', 'CONFLICT', 'NOT_SUPPORTED', 'RESOURCE_LIMIT'];
            const code = allowed.find(c => c === response.error?.code) ?? 'INTERNAL_ERROR';
            throw new DodoError(code, response.error?.message?.slice(0, 400) ?? 'desktop operation failed');
        }
        return response.data;
    }
}
