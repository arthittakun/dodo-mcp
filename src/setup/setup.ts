import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DodoError } from '../errors.js';
import { resolveTrustedExecutable } from '../platform/execResolve.js';
import { batchInvocation } from '../platform/shell.js';
import { ensurePrivateDirectory } from '../platform/privateFs.js';
import { isWithinPath } from '../platform/pathPolicy.js';
import { renameWithRetry, removeWithRetry } from '../platform/fsRetry.js';
import { findSpeechEngine } from '../platform/speech.js';
import { SRT_VERSION } from '../platform/windowsSandbox.js';
import { provisionWindowsSandbox } from './windowsSandboxInstall.js';
import { installWindowsSpeech } from './windowsSpeechInstall.js';
import { prepareWindowsChromiumSandboxAcl } from './windowsChromiumAcl.js';
import { verifySandbox } from './sandboxProbe.js';
import { verifyInstalledComponent } from './componentProbes.js';
import { buildChildEnv } from '../security/env.js';
import { loadGlobalConfig, GlobalConfigSchema, type GlobalConfig } from '../config/globalConfig.js';
import { sandboxAvailability } from '../services/jobs/sandbox.js';
import { NativeDesktopBackend, setupNativeDesktop } from '../services/desktop/nativeBackend.js';
import { activateManagedTools, registerManagedPath } from './managedTools.js';
import { downloadVerified, verifiedFile, MODEL_PIN, WINDOWS_PINS, extractWindowsZip } from './download.js';
import { importState, planStateImport, type StateImportPlan, type StateImportResult } from '../config/stateImport.js';

export const COMPONENTS = ['git', 'ripgrep', 'adb', 'cloudflared', 'ffmpeg', 'whisper', 'model', 'chromium', 'lsp', 'speech', 'desktop', 'sandbox', 'web'] as const;
export type Component = typeof COMPONENTS[number];
export type SetupState = 'ready' | 'missing' | 'needs-permission' | 'needs-backend' | 'failed';
export interface SetupItem { component: Component; state: SetupState; detail: string; action?: string }
export interface SetupOptions { cwd: string; configDir: string; check?: boolean; plan?: boolean; yes?: boolean; enableWeb?: boolean; components?: Component[]; detectExistingState?: boolean; importState?: boolean }
export interface SetupStateImportReport { plan: StateImportPlan; result?: StateImportResult }
export interface SetupReport { platform: string; arch: string; mode: 'check' | 'plan' | 'install'; components: SetupItem[]; complete: boolean; exitCode: number; receipt?: string; stateImport?: SetupStateImportReport }
const WHISPER_COMMIT = '306c88f4d1286aec1bf96e544632897886af5501';
const LSP_PACKAGES = ['pyright@1.1.414', 'vscode-langservers-extracted@4.10.0', 'yaml-language-server@1.24.0', 'bash-language-server@5.6.0'];
const LSP_ENTRIES = {
  python: { file: 'pyright/langserver.index.js', args: ['--stdio'], extensions: ['.py', '.pyi'] },
  html: { file: 'vscode-langservers-extracted/bin/vscode-html-language-server', args: ['--stdio'], extensions: ['.html', '.htm'] },
  css: { file: 'vscode-langservers-extracted/bin/vscode-css-language-server', args: ['--stdio'], extensions: ['.css', '.scss', '.less'] },
  json: { file: 'vscode-langservers-extracted/bin/vscode-json-language-server', args: ['--stdio'], extensions: ['.json', '.jsonc'] },
  yaml: { file: 'yaml-language-server/bin/yaml-language-server', args: ['--stdio'], extensions: ['.yaml', '.yml'] },
  bash: { file: 'bash-language-server/out/cli.js', args: ['start'], extensions: ['.sh', '.bash'] },
};
const require = createRequire(import.meta.url);

export function parseComponents(value: string): Component[] {
  if (value === 'all') return [...COMPONENTS];
  const values = [...new Set(value.split(',').map(v => v.trim()))];
  if (!values.length || values.some(v => !COMPONENTS.includes(v as Component))) throw new DodoError('INVALID_INPUT', `components must be all or a comma-separated selection of ${COMPONENTS.join(',')}`);
  return values as Component[];
}
function executable(root: string, name: string): string | undefined {
  try { return resolveTrustedExecutable(name, root); } catch { return undefined; }
}
function invocation(root: string, program: string, args: string[]) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(program) ? batchInvocation(program, args, root) : { program, args, windowsVerbatimArguments: false };
}
function probe(root: string, name: string, args = ['--version']): string | undefined {
  const binary = executable(root, name); if (!binary) return undefined;
  const call = invocation(root, binary, args);
  const result = spawnSync(call.program, call.args, { cwd: root, env: buildChildEnv({ parentEnv: process.env, workspaceRoot: root, extraAllowlist: [] }), shell: false, windowsHide: true, windowsVerbatimArguments: call.windowsVerbatimArguments, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  return !result.error && result.status === 0 ? `${binary}: ${(result.stdout || result.stderr).split(/\r?\n/)[0]?.slice(0, 200) ?? 'probe passed'}` : undefined;
}
function safeStateRoot(configDir: string, root: string): void {
  let nearest = path.resolve(configDir);
  while (!fs.existsSync(nearest)) { const parent = path.dirname(nearest); if (parent === nearest) break; nearest = parent; }
  const real = fs.realpathSync.native(nearest);
  if (isWithinPath(root, real) || isWithinPath(root, path.resolve(configDir))) throw new DodoError('PATH_DENIED', 'setup state/tools must be outside the project workspace');
}

function setupContext(cwd: string): string {
  const root = fs.realpathSync.native(cwd);
  // Setup is not a workspace server: running it from Home or a drive root
  // must not classify every per-user installed tool as repository code.
  return root === fs.realpathSync.native(os.homedir()) || root === path.parse(root).root ? fs.realpathSync.native(os.tmpdir()) : root;
}

export async function inspectSetup(options: SetupOptions): Promise<SetupReport> {
  const root = setupContext(options.cwd);
  safeStateRoot(options.configDir, root);
  activateManagedTools(options.configDir, root); // read-only ACL check; only this process gets the PATH entries.
  const config = loadGlobalConfig(path.join(options.configDir, 'config.json'));
  const results: SetupItem[] = [];
  for (const component of options.components ?? COMPONENTS) {
    let detail: string | undefined;
    if (component === 'git') detail = probe(root, 'git');
    if (component === 'ripgrep') detail = probe(root, 'rg');
    if (component === 'adb') detail = probe(root, 'adb', ['version']);
    if (component === 'cloudflared') detail = probe(root, 'cloudflared');
    if (component === 'ffmpeg') { const a = probe(root, 'ffmpeg', ['-version']), b = probe(root, 'ffprobe', ['-version']); if (a && b) detail = `${a}; ffprobe probe passed`; }
    if (component === 'whisper') detail = probe(root, 'whisper-cli', ['--help']) ?? probe(root, 'whisper-cpp', ['--help']);
    if (component === 'model' && await verifiedFile(path.join(options.configDir, 'models', 'ggml-tiny.bin'), MODEL_PIN)) detail = 'multilingual tiny model: exact pinned SHA-256 and size verified';
    if (component === 'chromium') {
      const { chromium } = await import('playwright');
      const binary = chromium.executablePath();
      try {
        const stat = fs.lstatSync(binary);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) detail = 'Playwright-matched Chromium executable is present; deep launch verifies its browser sandbox';
      } catch { /* missing browser remains missing */ }
    }
    if (component === 'lsp' && Object.keys(LSP_ENTRIES).every(language => {
      const server = config.lsp[language]; if (!server) return false;
      try {
        resolveTrustedExecutable(server.command, root, { allowAbsolute: true, allowBatch: false });
        return !server.args[0] || !path.isAbsolute(server.args[0]) || (fs.existsSync(server.args[0]) && fs.statSync(server.args[0]).isFile());
      } catch { return false; }
    })) detail = 'Python/HTML/CSS/JSON/YAML/Bash registered with available executables; existing owner registrations preserved (protocol behavior is tested separately)';
    if (component === 'speech') { const engine = findSpeechEngine(root); if (engine) detail = `${engine.kind}: ${engine.program}`; }
    if (component === 'desktop') {
      const backend = new NativeDesktopBackend(options.configDir);
      if (backend.available()) {
        try {
          const status = await backend.run({ op: 'status' }) as { screenRecording: boolean; accessibility: boolean; backend: string };
          if (status.screenRecording && status.accessibility) detail = `${status.backend}; app-specific DODO consent is still required`;
          else { results.push({ component, state: 'needs-permission', detail: 'backend installed; grant OS screen/accessibility permission in the interactive user session', action: 'dodo desktop setup --request-permissions' }); continue; }
        } catch (e) { results.push({ component, state: 'failed', detail: (e as Error).message }); continue; }
      } else if (!['darwin', 'win32', 'linux'].includes(process.platform)) {
        results.push({ component, state: 'needs-backend', detail: 'no reviewed desktop backend is packaged for this OS' }); continue;
      }
    }
    if (component === 'sandbox') {
      const status = sandboxAvailability(process.env, options.configDir, root);
      if (status.available) detail = `${status.kind}: available; setup installation runs bounded confinement checks`;
      else if (process.platform === 'win32') { results.push({ component, state: 'missing', detail: 'Windows sandbox runtime, native provisioning, or current confinement receipt is missing', action: 'install pinned sandbox runtime and verify file/network confinement' }); continue; }
    }
    if (component === 'web') {
      results.push({ component, state: config.allowWebFetch ? 'ready' : 'needs-permission', detail: config.allowWebFetch ? 'owner enabled SSRF-guarded HTTPS fetch' : 'software is already bundled; outbound access needs explicit owner consent', ...(!config.allowWebFetch ? { action: 'dodo setup --enable-web' } : {}) }); continue;
    }
    results.push(detail ? { component, state: 'ready', detail } : { component, state: 'missing', detail: 'missing or did not pass its bounded capability probe', action: `install ${component}` });
  }
  if (options.check) {
    for (const item of results) {
      if (item.state !== 'ready') continue;
      try {
        const proof = await verifyInstalledComponent(item.component, root, options.configDir);
        if (proof) item.detail = proof;
      } catch (error) {
        item.state = 'failed';
        item.detail = `capability verification failed: ${(error as Error).message.slice(0, 1000)}`;
      }
    }
  }
  const complete = results.every(item => item.state === 'ready');
  const stateImport = options.detectExistingState ? { plan: planStateImport(options.configDir) } : undefined;
  return { platform: process.platform, arch: process.arch, mode: options.check ? 'check' : options.plan ? 'plan' : 'install', components: results, complete, exitCode: complete ? 0 : results.some(item => item.state === 'failed') ? 1 : 2, ...(stateImport ? { stateImport } : {}) };
}

/** The local setup CLI alone chooses installers. No MCP tool or repository manifest selects commands. */
export async function runSetup(options: SetupOptions, log: (text: string) => void = console.log): Promise<SetupReport> {
  if ((options.check || options.plan) && options.enableWeb) throw new DodoError('INVALID_INPUT', '--enable-web cannot be combined with --check/--plan');
  const root = setupContext(options.cwd), configDir = path.resolve(options.configDir);
  if ((options.check || options.plan) && options.importState) throw new DodoError('INVALID_INPUT', '--import-state cannot be combined with --check/--plan');
  let stateImport: SetupStateImportReport | undefined;
  const importPlan = options.detectExistingState ? planStateImport(configDir) : undefined;
  if (options.importState) {
    if (!options.detectExistingState) throw new DodoError('INVALID_INPUT', '--import-state is available only with the default Dodo config directory; use an explicit import plan for custom state');
    if (importPlan?.state === 'blocked') {
      throw new DodoError('MIGRATION_REVIEW_REQUIRED', importPlan.reason ?? 'state import needs local review', {
        recovery: 'inspect the source locally; Dodo did not create or modify the target',
      });
    }
    if (importPlan?.state === 'available') {
      const result = importState(importPlan);
      stateImport = { plan: importPlan, result };
    } else if (importPlan) {
      stateImport = { plan: importPlan };
    }
  }
  if (!stateImport && importPlan) stateImport = { plan: importPlan };
  const initial = await inspectSetup({ ...options, ...(stateImport ? { detectExistingState: false } : {}) });
  if (options.check || options.plan) {
    if (stateImport) initial.stateImport = stateImport;
    return initial;
  }
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new DodoError('NOT_SUPPORTED', `no reviewed installer recipes for ${process.platform}`);
  const installTargets = initial.components.filter(item => item.state === 'missing' || item.state === 'failed').map(item => item.component);
  if (installTargets.length > 0 && !options.yes) {
    throw new DodoError('APPROVAL_REQUIRED', 'setup found components that require installation; no installer was started', {
      detail: { components: installTargets },
      recovery: 'review dodo setup --plan for those components, then rerun with --yes',
    });
  }
  ensurePrivateDirectory(configDir);
  const tools = path.join(configDir, 'tools'); ensurePrivateDirectory(tools);
  const receipts = path.join(configDir, 'setup-receipts'); ensurePrivateDirectory(receipts);
  const id = randomUUID(), lock = path.join(configDir, 'setup.lock'), token = JSON.stringify({ id, pid: process.pid, startedAt: new Date().toISOString() });
  try { fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 }); }
  catch { throw new DodoError('CONFLICT', 'another setup may be running (setup.lock exists); inspect it locally, do not auto-kill a process or steal its lock'); }
  const outcomes = new Map<Component, string>();
  const steps: Array<{ component: Component; command: string[]; exitCode: number | null; log: string }> = [];
  const run = (component: Component, program: string, args: string[], cwd: string, interactive = false): string => {
    const call = invocation(root, program, args);
    log(`[setup] ${component}: ${path.basename(program)} ${args.join(' ')}`);
    const env = buildChildEnv({ parentEnv: process.env, workspaceRoot: root, extraAllowlist: [] });
    const result = spawnSync(call.program, call.args, { cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: call.windowsVerbatimArguments, stdio: interactive ? 'inherit' : 'pipe', encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
    const record = `${id}-${steps.length}.log`;
    fs.writeFileSync(path.join(receipts, record), `${result.stdout ?? ''}\n${result.stderr ?? ''}`, { mode: 0o600, flag: 'wx' });
    steps.push({ component, command: [program, ...args], exitCode: result.status, log: record });
    if (result.error || result.status !== 0) throw new Error(`installer exited ${result.status ?? 'without a code'}; see setup receipt ${record}`);
    return result.stdout ?? '';
  };
  const packageInstall = (component: Component, packages: { brew: string[]; apt: string[]; dnf: string[] }): void => {
    const names = process.platform === 'darwin' ? ['brew'] : ['apt-get', 'dnf'];
    const manager = names.map(name => ({ name, binary: executable(root, name) })).find(item => item.binary);
    if (!manager?.binary) throw new Error('no supported package manager found (Homebrew or apt/dnf); bootstrap it with owner approval first');
    const pkg = manager.name === 'brew' ? packages.brew : manager.name === 'apt-get' ? packages.apt : packages.dnf;
    let program = manager.binary, args = ['install', ...(manager.name === 'brew' ? [] : ['-y']), ...pkg];
    if (manager.name !== 'brew' && process.getuid?.() !== 0) {
      const sudo = executable(root, 'sudo'); if (!sudo || !process.stdin.isTTY) throw new Error('system dependency installation needs a local sudo terminal; no password or elevation bypass was attempted');
      program = sudo; args = [manager.binary, ...args];
    }
    run(component, program, args, tools, true);
  };
  const installPortable = async (component: 'git' | 'ripgrep' | 'ffmpeg' | 'whisper') => {
    if (process.arch !== 'x64') throw new Error(`portable pin currently validated for win32/x64, not ${process.arch}; no incompatible binary was installed`);
    const pin = WINDOWS_PINS[component], directory = path.join(tools, `${component}-${pin.sha256.slice(0, 16)}`);
    const cache = path.join(tools, 'downloads'); ensurePrivateDirectory(cache);
    await downloadVerified(pin, path.join(cache, `${component}-${pin.sha256}.zip`));
    if (!fs.existsSync(directory)) {
      const stage = fs.mkdtempSync(path.join(tools, `.stage-${component}-`)); ensurePrivateDirectory(stage);
      try { extractWindowsZip(path.join(cache, `${component}-${pin.sha256}.zip`), stage); renameWithRetry(stage, directory); }
      finally { if (fs.existsSync(stage)) removeWithRetry(stage, true); }
    }
    const wanted = { git: 'git.exe', ripgrep: 'rg.exe', ffmpeg: 'ffmpeg.exe', whisper: 'whisper-cli.exe' }[component];
    const candidates: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 6) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error('managed archive contains a link');
        if (item.isDirectory()) walk(path.join(dir, item.name), depth + 1);
        else if (item.isFile() && item.name.toLowerCase() === wanted) candidates.push(path.join(dir, item.name));
      }
    };
    walk(directory, 0);
    const selected = candidates.find(p => component !== 'git' || path.basename(path.dirname(p)).toLowerCase() === 'cmd') ?? candidates[0];
    if (!selected) throw new Error(`verified archive did not contain ${wanted}`);
    registerManagedPath(configDir, path.dirname(selected)); activateManagedTools(configDir, root);
  };
  try {
    for (const item of initial.components) {
      if (item.state === 'ready') {
        // Playwright may already have downloaded Chromium while its Windows
        // AppContainer RX ACEs are missing (common for elevated Administrator
        // profiles). Reconcile only the exact browser revision; deep probing
        // below still decides whether the component is actually ready.
        if (process.platform === 'win32' && item.component === 'chromium') {
          try {
            const { chromium } = await import('playwright');
            prepareWindowsChromiumSandboxAcl(chromium.executablePath());
          } catch (error) { outcomes.set(item.component, (error as Error).message); }
        }
        continue;
      }
      if (item.state === 'needs-backend' || item.state === 'needs-permission') continue;
      const component = item.component;
      try {
        log(`[setup] installing missing ${component}`);
        if (['git', 'ripgrep', 'ffmpeg'].includes(component)) {
          if (process.platform === 'win32') await installPortable(component as 'git' | 'ripgrep' | 'ffmpeg');
          else packageInstall(component, { brew: [component], apt: [component], dnf: [component] });
        } else if (component === 'adb') {
          if (process.platform === 'darwin') packageInstall(component, { brew: ['android-platform-tools'], apt: [], dnf: [] });
          else if (process.platform === 'linux') packageInstall(component, { brew: [], apt: ['adb'], dnf: ['android-tools'] });
          else throw new Error('install the signed Android SDK Platform-Tools package from developer.android.com/tools/releases/platform-tools, then rerun dodo setup --check --components adb');
        } else if (component === 'cloudflared') {
          if (process.platform === 'darwin') packageInstall(component, { brew: ['cloudflared'], apt: [], dnf: [] });
          else throw new Error('automatic cloudflared installation is not enabled on this OS; install the signed official package from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ then rerun dodo setup --check --components cloudflared');
        } else if (component === 'whisper') {
          if (process.platform === 'win32') await installPortable('whisper');
          else if (process.platform === 'darwin') packageInstall(component, { brew: ['whisper-cpp'], apt: [], dnf: [] });
          else {
            packageInstall(component, { brew: [], apt: ['git', 'cmake', 'build-essential'], dnf: ['git', 'cmake', 'gcc-c++', 'make'] });
            const source = path.join(tools, `whisper-${WHISPER_COMMIT}`);
            const git = executable(root, 'git'), cmake = executable(root, 'cmake');
            if (!git || !cmake) throw new Error('source-build prerequisites unavailable after installation');
            if (!fs.existsSync(source)) run(component, git, ['clone', '--depth', '1', '--branch', 'v1.9.2', 'https://github.com/ggml-org/whisper.cpp', source], tools);
            if (run(component, git, ['rev-parse', 'HEAD'], source).trim() !== WHISPER_COMMIT) throw new Error('Whisper source commit does not match the reviewed pin');
            run(component, cmake, ['-S', source, '-B', path.join(source, 'build'), '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DWHISPER_BUILD_TESTS=OFF'], tools);
            run(component, cmake, ['--build', path.join(source, 'build'), '--config', 'Release', '--target', 'whisper-cli', '--parallel', '2'], tools);
            registerManagedPath(configDir, path.join(source, 'build', 'bin')); activateManagedTools(configDir, root);
          }
        } else if (component === 'model') {
          const models = path.join(configDir, 'models'); ensurePrivateDirectory(models);
          await downloadVerified(MODEL_PIN, path.join(models, 'ggml-tiny.bin'));
        } else if (component === 'chromium') {
          const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
          run(component, process.execPath, [cli, 'install', ...(process.platform === 'linux' ? ['--with-deps'] : []), 'chromium'], tools, process.platform === 'linux');
          if (process.platform === 'win32') {
            const { chromium } = await import('playwright');
            prepareWindowsChromiumSandboxAcl(chromium.executablePath());
          }
        } else if (component === 'lsp') {
          const prefix = path.join(tools, 'language-servers'); ensurePrivateDirectory(prefix);
          const npm = executable(root, 'npm'); if (!npm) throw new Error('npm is required for language-server setup');
          run(component, npm, ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org', ...LSP_PACKAGES], tools);
          updateOwnerConfig(configDir, current => {
            for (const [language, entry] of Object.entries(LSP_ENTRIES)) {
              if (current.lsp[language]) continue;
              const script = path.join(prefix, 'node_modules', entry.file);
              if (!fs.existsSync(script)) throw new Error(`missing installed language-server entrypoint: ${language}`);
              current.lsp[language] = { command: process.execPath, args: [script, ...entry.args], extensions: entry.extensions };
            }
            return current;
          });
        } else if (component === 'speech') {
          if (process.platform === 'win32') await installWindowsSpeech(configDir, root);
          else packageInstall(component, { brew: ['espeak-ng'], apt: ['espeak-ng'], dnf: ['espeak-ng'] });
        } else if (component === 'desktop') {
          if (process.platform === 'linux') packageInstall(component, { brew: [], apt: ['python3', 'python3-xlib', 'python3-pil', 'at-spi2-core', 'libatspi2.0-0'], dnf: ['python3', 'python3-xlib', 'python3-pillow', 'at-spi2-core'] });
          await setupNativeDesktop(configDir, false);
        }
        else if (component === 'sandbox') {
          if (process.platform === 'win32') {
            const prefix = path.join(tools, 'sandbox-runtime'); ensurePrivateDirectory(prefix);
            const packageRoot = path.join(prefix, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
            const manifest = path.join(packageRoot, 'package.json');
            let installed = false;
            try { const p = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name: string; version: string }; installed = p.name === '@anthropic-ai/sandbox-runtime' && p.version === SRT_VERSION; } catch { /* install the pinned package */ }
            if (!installed) {
              const npm = executable(root, 'npm'); if (!npm) throw new Error('npm is required to prepare the Windows sandbox');
              run(component, npm, ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org', `@anthropic-ai/sandbox-runtime@${SRT_VERSION}`], tools);
            }
            await provisionWindowsSandbox(configDir, root, packageRoot, log);
          } else if (process.platform === 'linux') packageInstall(component, { brew: [], apt: ['bubblewrap'], dnf: ['bubblewrap'] });
          else throw new Error('the macOS system sandbox is absent; setup cannot replace an OS security facility');
        }
      } catch (error) { outcomes.set(component, (error as Error).message); log(`[setup] ${component}: ${(error as Error).message}`); }
    }
    if (options.enableWeb) updateOwnerConfig(configDir, current => ({ ...current, allowWebFetch: true }));
    const result = await inspectSetup({ ...options, detectExistingState: false });
    for (const item of result.components) if (outcomes.has(item.component)) { item.state = 'failed'; item.detail = outcomes.get(item.component)!; }
    // Installer success is not readiness. Exercise installed components with
    // private synthetic fixtures before reporting them as ready.
    for (const item of result.components) {
      if (item.state !== 'ready') continue;
      try {
        const proof = await verifyInstalledComponent(item.component, root, configDir);
        if (proof) item.detail = proof;
      } catch (error) {
        item.state = 'failed';
        item.detail = `capability verification failed: ${(error as Error).message.slice(0, 1000)}`;
      }
    }
    const sandbox = result.components.find(item => item.component === 'sandbox' && item.state === 'ready');
    if (sandbox) {
      try { const proof = await verifySandbox(configDir, root); sandbox.detail = `native ${proof.platform} confinement checks passed: ${proof.checks.join(', ')}`; }
      catch (error) { sandbox.state = 'failed'; sandbox.detail = `sandbox confinement verification failed: ${(error as Error).message.slice(0, 1000)}`; }
    }
    result.complete = result.components.every(item => item.state === 'ready'); result.exitCode = result.complete ? 0 : result.components.some(item => item.state === 'failed') ? 1 : 2;
    if (stateImport) result.stateImport = stateImport;
    const receipt = path.join(receipts, `${id}.json`); result.receipt = receipt;
    fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, kind: 'dodo-setup-receipt', ...result, completedAt: new Date().toISOString(), steps, scope: 'explicit local owner setup; no DODO OAuth/workspace-access/trust/desktop-consent resets; native sandbox provisioning may create its own dedicated account and SID-scoped rules', webConsentRequested: options.enableWeb === true, restartRequiredForExistingServer: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } finally { try { if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock); } catch { /* Never remove a replaced lock. */ } }
}

function updateOwnerConfig(configDir: string, update: (current: GlobalConfig) => GlobalConfig): void {
  const file = path.join(configDir, 'config.json');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new DodoError('PATH_DENIED', 'owner configuration cannot be a link');
    if (stat.size > 1024 * 1024) throw new DodoError('RESOURCE_LIMIT', 'owner configuration is oversized');
  }
  const before = fs.existsSync(file) ? { bytes: fs.readFileSync(file), mtime: fs.statSync(file, { bigint: true }).mtimeNs } : undefined;
  const current = before ? GlobalConfigSchema.parse(JSON.parse(before.bytes.toString('utf8'))) : GlobalConfigSchema.parse({});
  const content = JSON.stringify(GlobalConfigSchema.parse(update(current)), null, 2) + '\n';
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    if (before ? !fs.existsSync(file) || fs.statSync(file, { bigint: true }).mtimeNs !== before.mtime || !fs.readFileSync(file).equals(before.bytes) : fs.existsSync(file)) throw new DodoError('FILE_CHANGED', 'owner config changed concurrently; setup did not overwrite it');
    renameWithRetry(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export const SETUP_MODULE_FILE = fileURLToPath(import.meta.url); // Useful to verify the shipped CLI uses its own implementation.
