import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

/** A. CLI, root, configuration (CLI-01..10, CFG-03..05). Drives the REAL built CLI. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist/cli/main.js');

function runCli(args: string[], opts: { cwd: string; configDir: string; expectFail?: boolean; env?: NodeJS.ProcessEnv }): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, DODO_CONFIG_DIR: opts.configDir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

describe('CLI', () => {
  let base: string;
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-cli-'));
    // Ensure the project is built.
    if (!fs.existsSync(CLI)) execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'inherit' });
  });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('CLI: --version and doctor run without a public URL', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'proj-'));
    const ver = runCli(['--version'], { cwd: proj, configDir: cfg });
    expect(ver.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const doc = runCli(['doctor'], { cwd: proj, configDir: cfg });
    expect(doc.stdout).toContain('node');
    expect(doc.stdout).toContain('config-dir');
  });

  it('CLI: init writes a global config and does not touch the repo', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'proj-'));
    const res = runCli(['init', '--public-url', 'https://dodo.example.com'], { cwd: proj, configDir: cfg });
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(cfg, 'config.json'))).toBe(true);
    expect(fs.readdirSync(proj)).toEqual([]); // repo untouched
    const conf = JSON.parse(fs.readFileSync(path.join(cfg, 'config.json'), 'utf8'));
    expect(conf.publicUrl).toBe('https://dodo.example.com');
  });

  it('CLI: init rejects an http public URL without the insecure flag', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'proj-'));
    const res = runCli(['init', '--public-url', 'http://dodo.example.com'], { cwd: proj, configDir: cfg, expectFail: true });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/https/);
  });

  it('CLI: setup plan is read-only and missing installers require --yes', () => {
    const cfg = path.join(base, 'setup-plan-cfg');
    const proj = fs.mkdtempSync(path.join(base, 'setup-plan-proj-'));
    const plan = runCli(['setup', '--plan', '--components', 'model', '--json'], { cwd: proj, configDir: cfg, expectFail: true });
    expect(plan.code).toBe(2);
    expect(JSON.parse(plan.stdout)).toMatchObject({ mode: 'plan', components: [{ component: 'model', state: 'missing' }] });
    expect(fs.existsSync(cfg)).toBe(false);
    const install = runCli(['setup', '--components', 'model'], { cwd: proj, configDir: cfg, expectFail: true });
    expect(install.code).not.toBe(0);
    expect(install.stderr).toMatch(/no installer was started/);
    expect(fs.existsSync(cfg)).toBe(false);
  });

  it('CLI tunnel: saves only a credential reference and never starts without explicit --yes', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'tunnel-cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'tunnel-proj-'));
    const fakeToken = 'cli-fixture-cloudflare-token-1234567890';
    const configured = runCli(['tunnel', 'configure', '--managed', '--token-env', 'FIXTURE_TUNNEL_TOKEN', '--metrics-port', '32173', '--max-restarts', '1', '--json'], {
      cwd: proj, configDir: cfg, env: { FIXTURE_TUNNEL_TOKEN: fakeToken },
    });
    expect(configured.code).toBe(0);
    expect(configured.stdout).not.toContain(fakeToken);
    const configText = fs.readFileSync(path.join(cfg, 'config.json'), 'utf8');
    expect(configText).not.toContain(fakeToken);
    expect(JSON.parse(configText).tunnel).toEqual({ mode: 'managed', startWithDodo: true, credentialRef: { provider: 'env', name: 'FIXTURE_TUNNEL_TOKEN' }, metricsPort: 32173, maxRestarts: 1 });
    const refused = runCli(['tunnel', 'start'], { cwd: proj, configDir: cfg, expectFail: true, env: { FIXTURE_TUNNEL_TOKEN: fakeToken } });
    expect(refused.code).not.toBe(0); expect(refused.stderr).toContain('--yes');
    expect(refused.stderr).not.toContain(fakeToken);
    const status = runCli(['tunnel', 'status', '--json'], { cwd: proj, configDir: cfg });
    expect(JSON.parse(status.stdout)).toMatchObject({ configuredMode: 'managed', supervisor: null });
  });

  it('CLI-10: refuses the home directory as a workspace root', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'cfg-'));
    const res = runCli(['trust', '--mode', 'inspect'], { cwd: os.homedir(), configDir: cfg, expectFail: true });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/home directory|unsafe/i);
  });

  it('CLI: trusted mode requires explicit --yes', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'proj-'));
    const noYes = runCli(['trust', '--mode', 'trusted'], { cwd: proj, configDir: cfg, expectFail: true });
    expect(noYes.code).not.toBe(0);
    expect(noYes.stderr).toMatch(/privileges|--yes/);
    const withYes = runCli(['trust', '--mode', 'trusted', '--yes'], { cwd: proj, configDir: cfg });
    expect(withYes.code).toBe(0);
  });

  it('CLI: auth add-client validates redirect URIs and prints a secret once', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'proj-'));
    const wild = runCli(['auth', 'add-client', '--redirect-uri', 'https://x.com/*'], { cwd: proj, configDir: cfg, expectFail: true });
    expect(wild.code).not.toBe(0);
    const ok = runCli(['auth', 'add-client', '--redirect-uri', 'https://chatgpt.com/connector_platform_oauth_redirect'], { cwd: proj, configDir: cfg });
    expect(ok.stdout).toMatch(/client_id/);
    expect(ok.stdout).toMatch(/client_secret/);
  });

  it('CLI-05: bare status with no server gives an actionable error, not a crash', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'proj-'));
    const res = runCli(['status'], { cwd: proj, configDir: cfg, expectFail: true });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/no running DODO/);
  });

  it.skipIf(process.platform !== 'darwin')('CLI desktop on macOS: save before start, survive restart, isolate nested roots and revoke while stopped', async () => {
    const cfg = fs.mkdtempSync(path.join(base, 'desktop-cfg-'));
    const mono = fs.mkdtempSync(path.join(base, 'desktop-mono-'));
    const web = path.join(mono, 'โปรเจกต์ ITP006', 'apps', 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ configPort: 0 }));
    const saved = runCli(['desktop', 'allow', '--app', 'com.google.Chrome', '--mode', 'control', '--persist', '--yes'], { cwd: web, configDir: cfg });
    expect(saved.code).toBe(0);
    expect(saved.stdout).toContain('Remembered until disabled');
    expect(fs.readdirSync(web)).toEqual([]);
    expect(runCli(['status'], { cwd: web, configDir: cfg }).code).not.toBe(0); // save never starts a listener
    const epochs = new Set<string>();
    for (const [cwd, mode] of [[web, 'control'], [web, 'control'], [mono, 'off'], [web, 'off']] as const) {
      if (epochs.size === 3) {
        const disabled = runCli(['desktop', 'disable'], { cwd: web, configDir: cfg });
        expect(disabled.code).toBe(0);
        expect(disabled.stdout).toContain('disabled and forgotten');
      }
      const port = await freePort();
      const child = spawn(process.execPath, [CLI, 'start', '--root', cwd, '--port', String(port), '--quiet'], {
        cwd, env: { ...process.env, DODO_CONFIG_DIR: cfg }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      child.stdout.on('data', c => { log += String(c); });
      child.stderr.on('data', c => { log += String(c); });
      try {
        await waitFor(async () => {
          if (child.exitCode !== null) throw Error(`startup failed: ${log}`);
          const r = runCli(['status', '--json'], { cwd, configDir: cfg });
          return r.code === 0 ? r.stdout : undefined;
        }, 15000);
        const status = runCli(['desktop', 'status'], { cwd, configDir: cfg });
        expect(status.code).toBe(0);
        const d = JSON.parse(status.stdout) as { policy: { mode: string; persistent: boolean; expiresAt: number | null; epoch: string; allowedApps: string[] } };
        expect(d.policy.mode).toBe(mode);
        expect(d.policy.persistent).toBe(mode === 'control');
        if (mode === 'control') {
          expect(d.policy.expiresAt).toBeNull();
          expect(d.policy.allowedApps).toEqual(['com.google.Chrome']);
        }
        expect(epochs.has(d.policy.epoch)).toBe(false);
        epochs.add(d.policy.epoch);
      } finally {
        child.kill('SIGTERM');
        if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('close', () => resolve()));
      }
    }
  }, 60000);

  it('CLI desktop: persistent permission needs acknowledgment and cannot also have minutes', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'desktop-flags-'));
    const proj = fs.mkdtempSync(path.join(base, 'desktop-proj-'));
    const args = ['desktop', 'allow', '--app', 'com.google.Chrome', '--mode', 'control', '--persist'];
    const noYes = runCli(args, { cwd: proj, configDir: cfg });
    expect(noYes.code).not.toBe(0);
    expect(noYes.stderr).toContain('--yes');
    const both = runCli([...args, '--yes', '--minutes', '60'], { cwd: proj, configDir: cfg });
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain('not both');
    expect(fs.readdirSync(cfg)).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('CLI desktop on Linux fails closed when no native helper is installed', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'desktop-linux-cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'desktop-linux-proj-'));
    const app = `linux.${'a'.repeat(40)}`;
    const result = runCli(['desktop', 'allow', '--app', app, '--mode', 'control', '--persist', '--yes'], { cwd: proj, configDir: cfg });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('NOT_SUPPORTED');
    expect(fs.readdirSync(cfg)).toEqual([]);
  });

  it.each([
    { args: ['start'] as string[], mode: 'inspect' },
    { args: ['start', '--allow', '--all'], mode: 'trusted' },
    { args: ['--bypass'], mode: 'trusted' },
  ])('CLI-NEW: explicit --root opens the reviewed workspace and private config', async ({ args, mode }) => {
    const cfg = fs.mkdtempSync(path.join(base, 'new-cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'new-proj-'));
    const port = await freePort();
    fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ port, configPort: 0 }));
    const commandArgs = args[0] === '--bypass' ? [...args, '--root', proj] : [...args, '--root', proj];
    const child = spawn('node', [CLI, ...commandArgs], { cwd: base, env: { ...process.env, DODO_CONFIG_DIR: cfg }, stdio: ['ignore','pipe','pipe'] });
    let log = '';
    child.stdout.on('data', c => { log += String(c); });
    try {
      await waitFor(async () => log.includes('Private config') ? 'ready' : undefined, 15000);
      const url = new URL(log.match(/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]+)/)![0]);
      const res = await fetch(`${url.origin}/api/state`, {headers:{authorization:`Bearer ${url.hash.slice(1)}`}});
      expect(res.status).toBe(200);
      const state = await res.json() as { workspace: { root: string; switchSupported: boolean }; permissions: { effectiveMode: string; savedMode: string; override: string | null } };
      expect(fs.realpathSync(state.workspace.root)).toBe(fs.realpathSync(proj));
      expect(state.workspace.switchSupported).toBe(true);
      expect(state.permissions.effectiveMode).toBe(mode);
      expect(state.permissions.savedMode).toBe('inspect');
      expect(state.permissions.override).toBe(mode === 'trusted' ? (commandArgs.includes('--bypass') ? 'bypass' : 'allow-all') : null);
      expect((await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST'})).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/api/state`)).status).toBe(404);
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once('close', () => resolve()));
    }
  }, 20000);

  it('CLI launcher: bare dodo from an arbitrary directory exposes no workspace until the owner selects one', async () => {
    const cfg = fs.mkdtempSync(path.join(base, 'launcher-cfg-'));
    const unrelated = fs.mkdtempSync(path.join(base, 'launcher-cwd-'));
    const port = await freePort();
    fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ port, configPort: 0 }));
    const child = spawn(process.execPath, [CLI], { cwd: unrelated, env: { ...process.env, DODO_CONFIG_DIR: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (chunk) => { log += String(chunk); });
    child.stderr.on('data', (chunk) => { log += String(chunk); });
    try {
      await waitFor(async () => log.includes('Private config') ? 'ready' : undefined, 15000);
      const privateUrl = new URL(log.match(/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]+)/)![0]);
      const response = await fetch(`${privateUrl.origin}/api/state`, { headers: { authorization: `Bearer ${privateUrl.hash.slice(1)}` } });
      expect(response.status).toBe(200);
      const state = await response.json() as { workspace: null; connection: { workspaceSelected: boolean } };
      expect(state.workspace).toBeNull();
      expect(state.connection.workspaceSelected).toBe(false);
      expect(log).not.toContain(fs.realpathSync(unrelated));
      expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' })).status).toBe(503);
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once('close', () => resolve()));
    }
  }, 20000);

  it('CLI-NEW: --allow and --all must be paired', () => {
    const cfg = fs.mkdtempSync(path.join(base, 'flag-cfg-'));
    for (const flag of ['--allow','--all']) {
      const r = runCli(['start',flag],{cwd:base,configDir:cfg});
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('together');
    }
  });

  it('CLI-03/CLI-01: explicit --root selects the project without binding the process CWD', async () => {
    const cfg = fs.mkdtempSync(path.join(base, 'cfg-'));
    // Monorepo layout: start inside apps/web.
    const mono = fs.mkdtempSync(path.join(base, 'mono-'));
    const web = path.join(mono, 'apps', 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(path.join(web, 'index.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(mono, 'SIBLING_SECRET.txt'), 'must not be visible\n');
    const port = await freePort();
    fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({configPort:0}));
    const logFile = path.join(cfg, 'child.log');
    const logFd = fs.openSync(logFile, 'w');
    const child = spawn('node', [CLI, 'start', '--root', web, '--port', String(port), '--quiet'], {
      cwd: base,
      env: { ...process.env, DODO_CONFIG_DIR: cfg },
      stdio: ['ignore', logFd, logFd],
    });
    try {
      // Wait for the IPC socket / listener.
      await waitFor(async () => {
        const r = runCli(['status', '--json'], { cwd: web, configDir: cfg });
        return r.code === 0 ? r.stdout : undefined;
      }, 15000).catch((e) => {
        throw new Error(`${e}; child log: ${fs.readFileSync(logFile, 'utf8').slice(0, 800)}`);
      });
      const status = JSON.parse(runCli(['status', '--json'], { cwd: web, configDir: cfg }).stdout) as { root: string };
      expect(fs.realpathSync(status.root)).toBe(fs.realpathSync(web));
      expect(status.root).not.toContain('SIBLING_SECRET');
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 40_000);

  it('CLI-06: a second server on the same port exits nonzero (no kill / no port switch)', async () => {
    const cfg = fs.mkdtempSync(path.join(base, 'cfg-'));
    const proj = fs.mkdtempSync(path.join(base, 'proj-'));
    fs.writeFileSync(path.join(proj, 'f.txt'), 'x');
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', () => r()));
    try {
      const res = runCli(['start', '--port', String(port), '--quiet'], { cwd: proj, configDir: cfg, expectFail: true });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toMatch(/in use/);
      expect(blocker.listening).toBe(true); // the conflicting process was NOT killed
    } finally {
      blocker.close();
    }
  }, 30_000);
});

async function waitFor(fn: () => Promise<string | undefined>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 200));
  }
}
