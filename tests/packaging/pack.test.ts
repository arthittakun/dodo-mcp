import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { COMPACT_CATALOG, HYBRID_CATALOG, surfaceCatalog } from '../../src/tools/surface.js';
import { resolveTrustedExecutable } from '../../src/platform/execResolve.js';
import { batchInvocation } from '../../src/platform/shell.js';

/** G. Packaging (PACK-01..06). Runs the real `npm pack` and inspects the tarball. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** npm is a native executable or a guarded batch shim, never an assumed POSIX file. */
function runNpm(args: string[], cwd: string): string {
  const executable = resolveTrustedExecutable('npm', ROOT);
  const invocation = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
    ? batchInvocation(executable, args, ROOT)
    : { program: executable, args, windowsVerbatimArguments: false };
  const result = spawnSync(invocation.program, invocation.args, {
    cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`npm ${args[0]} failed (${result.status}): ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

describe('PACK: npm tarball', () => {
  let tarball: string;
  let fileList: string[];
  let workDir: string;
  let installedBin: string;

  afterAll(() => {
    // The fresh install includes native dependencies and private fixture state.
    // Remove only this suite's temporary directory, including after a failure.
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-pack-'));
    // Ensure a fresh build + schemas.
    execFileSync(process.execPath, ['scripts/clean-build-artifacts.mjs'], { cwd: ROOT, stdio: 'pipe' });
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' });
    execFileSync(process.execPath, ['scripts/emit-schemas.mjs'], { cwd: ROOT, stdio: 'pipe' });
    execFileSync(process.execPath, ['scripts/copy-ui.mjs'], { cwd: ROOT, stdio: 'pipe' });
    const out = runNpm(['pack', '--pack-destination', workDir, '--json'], ROOT);
    const meta = JSON.parse(out) as Array<{ filename: string; files: Array<{ path: string }> }>;
    tarball = path.join(workDir, meta[0]!.filename);
    fileList = meta[0]!.files.map((f) => f.path);
  }, 180_000);

  it('PACK-01: contains dist, schemas, examples and docs — no source maps of state', () => {
    expect(fileList.some((f) => f.startsWith('dist/cli/main.js'))).toBe(true);
    expect(fileList).toContain('schemas/tools.json');
    expect(fileList).toContain('package.json');
    expect(fileList).toContain('README.md');
    for (const file of ['dist/cli/menu.js', 'dist/platform/execResolve.js', 'dist/platform/privateFs.js', 'dist/ipc/authentication.js', 'dist/tunnel/credentials.js', 'dist/tunnel/supervisor.js', 'dist/tunnel/control.js', 'dist/services/brain/brainWorker.js', 'dist/services/context/contextEngine.js', 'dist/services/memory/memoryService.js', 'dist/services/runtime/runtimeService.js', 'dist/services/agent/agentService.js', 'dist/services/android/androidService.js', 'dist/services/android/adbBackend.js', 'dist/tools/androidTools.js', 'dist/evaluation/contracts.js', 'dist/evaluation/dodoBench.js', 'dist/tools/contextTools.js', 'dist/tools/memoryTools.js', 'dist/tools/runtimeTools.js', 'dist/tools/agentRuntimeTools.js', 'docs/ANDROID.md', 'docs/BRAIN.md', 'docs/CONTEXT.md', 'docs/MEMORY.md', 'docs/RUNTIME.md', 'docs/AGENT_RUNTIME.md', 'docs/EVALUATION.md', 'docs/RELEASE_1.0.0.md', 'docs/RELEASE_1.0.4.md', 'docs/RELEASE_1.0.5.md', 'docs/RELEASE_1.1.0.md', 'docs/RELEASE_1.2.0.md', 'docs/WINDOWS.md', 'docs/WINDOWS_SETUP.md', 'docs/WEB_CLIENTS.md', 'docs/adr/044-global-launcher-and-cli-menu.md', 'docs/adr/049-android-adb-control.md', 'docs/adr/050-cloudflare-local-and-project-access.md']) expect(fileList).toContain(file);
    const privateDocs = [
      /^docs\/development\//,
      /^docs\/(DEVELOPMENT_ROADMAP|WINDOWS_PLAN|WINDOWS_DEV_PROPOSAL_TH)\.md$/,
      /^(DODO_IMPLEMENTATION_SPEC|DODO_IMPLEMENTATION_PLAN_AND_ACCEPTANCE|RESEARCH_SOURCES)\.md$/,
    ];
    expect(fileList.some((file) => privateDocs.some((pattern) => pattern.test(file)))).toBe(false);
    expect(fileList.some(f => f.startsWith('dist/services/consent/') || f.startsWith('dist/tools/consentTools.'))).toBe(false);
    expect(fileList).not.toContain('dist/config/migration.js');
    expect(fileList).not.toContain('dist/config/migration.js.map');
    expect(fileList).not.toContain('dist/.build-marker');
  });

  it('PACK-07: ships the Local Config UI assets next to the compiled server', () => {
    for (const asset of [
      'dist/server/configUi/index.html', 'dist/server/configUi/app.css', 'dist/server/configUi/app.js', 'dist/server/remoteConfig.js',
      'dist/server/configUi/workbench.js', 'dist/server/configUi/workbench.css',
      'dist/server/configUi/ui/dom.js', 'dist/server/configUi/ui/recovery.js', 'dist/server/configUi/ui/tooltips.js', 'dist/server/configUi/ui/alerts.js',
      'dist/server/configUi/vendor/sweetalert2.min.js', 'dist/server/configUi/vendor/sweetalert2.min.css',
    ]) {
      expect(fileList, asset).toContain(asset);
    }
    // The UI never loads anything from a CDN: no absolute script/style URLs.
    const html = fs.readFileSync(path.join(ROOT, 'src/server/configUi/index.html'), 'utf8');
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    const appCss = fs.readFileSync(path.join(ROOT, 'src/server/configUi/app.css'), 'utf8');
    expect(appCss).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
    // The vendored SweetAlert2 matches the pinned devDependency byte-for-byte.
    const pinned = fs.readFileSync(path.join(ROOT, 'node_modules/sweetalert2/dist/sweetalert2.min.js'));
    const vendored = fs.readFileSync(path.join(ROOT, 'src/server/configUi/vendor/sweetalert2.min.js'));
    expect(vendored.equals(pinned)).toBe(true);
  });

  it('PACK-08: ships the desktop helper source without installing or enabling desktop access', () => {
    expect(fileList).toContain('native/desktop.swift');
    expect(fileList.some(f => /^native\/.*(?:arm64|x64)$/.test(f))).toBe(false);
  });

  it('PACK-10: ships assistance/media documentation and explicit setup, never models or recordings', () => {
    for (const file of ['docs/ASSISTANCE.md', 'docs/MULTIMODAL.md', 'docs/RELEASE_NOTES.md', 'scripts/setup-multimodal.mjs', 'scripts/guard-publish.mjs', 'dist/services/multimodal/mediaWorker.js']) expect(fileList).toContain(file);
    expect(fileList.some(f => /^(?:models|tmp|release-evidence)\//.test(f) || /\.(?:bin|mp4|aiff|wav|db)$/.test(f))).toBe(false);
  });

  it('PACK-16: ships evaluation contracts but no benchmark results or private release evidence', () => {
    expect(fileList).toContain('dist/evaluation/contracts.js');
    expect(fileList).toContain('dist/evaluation/dodoBench.js');
    expect(fileList).toContain('docs/EVALUATION.md');
    expect(fileList.some((file) => file.startsWith('benchmarks/') || file.startsWith('release-evidence/'))).toBe(false);
  });

  it('PACK-01: contains NO secrets, keys, tokens, or state database', () => {
    const forbidden = [
      /\.env/, /state\.db/, /jwks\.json/, /cookies\.json/, /cloudflared\.log$/, /tunnel\/state\.json$/, /\.sock$/, /id_rsa/, /\.pem$/,
      /\.dodo-dev-state/, /node_modules/, /\.git\//,
    ];
    for (const f of fileList) {
      for (const pat of forbidden) {
        expect(pat.test(f), `packaged file ${f} matches forbidden ${pat}`).toBe(false);
      }
    }
  });

  it('PACK-05: package.json declares NO install lifecycle hooks (no autostart/listener/tunnel)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      expect(scripts[hook], hook).toBeUndefined();
    }
  });

  it('PACK-13: manifest and lockfile agree and do not install an older DODO inside itself', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(pkg.dependencies[pkg.name]).toBeUndefined();
    expect(lock.packages[''].dependencies[pkg.name]).toBeUndefined();
    expect(lock.packages[`node_modules/${pkg.name}`]).toBeUndefined();
  });

  it('PACK-02: installs into a fresh prefix and the dodo binary is wired', () => {
    const installDir = fs.mkdtempSync(path.join(workDir, 'install-'));
    fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }));
    runNpm(['install', tarball, '--no-audit', '--no-fund'], installDir);
    const shim = path.join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'dodo.cmd' : 'dodo');
    expect(fs.existsSync(shim)).toBe(true);
    // Windows .bin files are shell wrappers, not JavaScript for node.exe.
    const binPath = path.join(installDir, 'node_modules', 'dodo-mcp', 'dist', 'cli', 'main.js');
    expect(fs.existsSync(binPath)).toBe(true);
    installedBin = binPath;
    const menu = execFileSync(process.execPath, [binPath, '--cli'], {
      cwd: installDir,
      env: { ...process.env, DODO_CONFIG_DIR: path.join(workDir, 'menu-cfg') },
      input: '0\n',
      encoding: 'utf8',
    });
    expect(menu).toContain('DODO Control Center');
    expect(menu).toContain('cloudflared');
    // The installed CLI runs (doctor exits 0 or 1 but prints checks) from a fresh prefix.
    const cfg = fs.mkdtempSync(path.join(workDir, 'cfg-'));
    let out = '';
    try {
      out = execFileSync(process.execPath, [binPath, 'doctor'], { cwd: installDir, env: { ...process.env, DODO_CONFIG_DIR: cfg }, encoding: 'utf8' });
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? '';
    }
    expect(out).toContain('sqlite-native');
    expect(out).toContain('node');
    const grantArgs = [binPath, 'desktop', 'allow', '--app', 'dev.dodo.fixture', '--mode', 'view', '--persist', '--yes'];
    const grantOptions = { cwd: installDir, env: { ...process.env, DODO_CONFIG_DIR: cfg }, encoding: 'utf8' as const, stdio: 'pipe' as const };
    if (process.platform !== 'darwin') {
      let refusal = '';
      try { execFileSync(process.execPath, grantArgs, grantOptions); }
      catch (error) { refusal = String((error as { stderr?: string }).stderr ?? ''); }
      expect(refusal).toContain('NOT_SUPPORTED');
    } else {
      expect(execFileSync(process.execPath, grantArgs, grantOptions)).toContain('Remembered until disabled');
    }
    const disabled = execFileSync(process.execPath, [binPath, 'desktop', 'disable'], {
      cwd: installDir, env: { ...process.env, DODO_CONFIG_DIR: cfg }, encoding: 'utf8',
    });
    expect(disabled).toContain('disabled and forgotten');
    const killed = execFileSync(process.execPath, [binPath, 'kill', '--json'], {
      cwd: os.homedir(), env: { ...process.env, DODO_CONFIG_DIR: cfg }, encoding: 'utf8',
    });
    expect(JSON.parse(killed)).toMatchObject({ stopped: [], failed: [], authPreserved: true });
  }, 120_000);

  it('PACK-14: installed CLI includes the owner project registry and migrates fresh state', () => {
    const root = path.join(workDir, 'registered โปรเจกต์');
    const cfg = path.join(workDir, 'project-registry-cfg');
    fs.mkdirSync(root, { recursive: true });
    const options = { cwd: workDir, env: { ...process.env, DODO_CONFIG_DIR: cfg }, encoding: 'utf8' as const };
    const added = JSON.parse(execFileSync(process.execPath, [installedBin, 'project', 'add', root, '--name', 'Packed project', '--json'], options)) as { project: { projectId: string; root: string } };
    expect(added.project.projectId).toMatch(/^prj_/);
    expect(added.project.root).toBe(fs.realpathSync.native(root));
    const listed = JSON.parse(execFileSync(process.execPath, [installedBin, 'project', 'list', '--json'], options)) as Array<{ projectId: string; displayName: string }>;
    expect(listed).toEqual([expect.objectContaining({ projectId: added.project.projectId, displayName: 'Packed project' })]);
    expect(fileList).toContain('dist/projects/registry.js');
    expect(fileList).toContain('dist/server/configUi/index.html');
  });

  it('PACK-11: installed media setup is wired and check/help do not install or change configuration', () => {
    const helper = path.resolve(path.dirname(installedBin), '../../scripts/setup-multimodal.mjs');
    expect(fs.existsSync(helper)).toBe(true);
    const cwd = fs.mkdtempSync(path.join(workDir, 'setup-check-'));
    const config = path.join(cwd, 'not-created-config');
    const options = { cwd, env: { ...process.env, DODO_CONFIG_DIR: config }, encoding: 'utf8' as const, timeout: 60000 };
    expect(execFileSync(process.execPath, [helper, '--help'], options)).toContain('Usage: dodo-media-setup');
    expect(execFileSync(process.execPath, [helper, '--check'], options)).toContain('No DODO permissions/configuration changed');
    expect(() => execFileSync(process.execPath, [helper, '--check', '--download-model'], { ...options, stdio: 'pipe' })).toThrow();
    expect(fs.existsSync(path.join(cwd, 'models'))).toBe(false);
    expect(fs.existsSync(config)).toBe(false);
  });

  it('PACK-09: installed tarball dispatches directly from nested Thai/spaced CWD', async () => {
    const root = path.join(workDir,'โปรเจกต์ ทดสอบ','nested'); fs.mkdirSync(root,{recursive:true});
    const cfg = fs.mkdtempSync(path.join(workDir,'direct-cfg-'));
    fs.writeFileSync(path.join(root,'proof.txt'),'packed fixture');
    const client = new Client({name:'packed-direct-client',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[installedBin,'stdio'],cwd:root,env:{...process.env,DODO_CONFIG_DIR:cfg} as Record<string,string>,stderr:'pipe'}));
    try {
      const overview = await client.callTool({name:'project_overview',arguments:{}});
      const e = overview.structuredContent as {ok:boolean;workspaceId:string;workspaceEpoch:string;data:{root:string}};
      expect(e.ok).toBe(true); expect(e.data.root).toBe(fs.realpathSync(root));
      const read = await client.callTool({name:'read_files',arguments:{workspaceId:e.workspaceId,workspaceEpoch:e.workspaceEpoch,files:[{path:'proof.txt'}]}});
      expect(JSON.stringify(read.structuredContent)).toContain('packed fixture');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(surfaceCatalog('full', { subagents: false }).map((tool) => tool.name));
    } finally {await client.close();}
  });

  it('PACK-12: ships the compact surface schema and the installed CLI serves it on request', async () => {
    expect(fileList).toContain('schemas/tools.compact.json');
    expect(fileList).toContain('schemas/tools.hybrid.json');
    const hybrid = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/tools.hybrid.json'), 'utf8')) as { toolCount: number; tools: Array<{ name: string }> };
    expect(hybrid.toolCount).toBe(HYBRID_CATALOG.length);
    expect(hybrid.toolCount).toBe(49);
    expect(hybrid.tools.map((t) => t.name)).toEqual(HYBRID_CATALOG.map((t) => t.name));
    const compact = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/tools.compact.json'), 'utf8')) as {
      toolCount: number; defaultLiveToolCount: number; fullToolCount: number; defaultLiveFullToolCount: number;
      optionalMcpFeatures: { subagents: { default: boolean; operations: string[] } };
      stats: { compact: { schemaBytes: number }; full: { schemaBytes: number } };
      tools: Array<{ name: string; inputSchema: { additionalProperties: unknown }; operations?: string[] }>;
    };
    expect(compact.toolCount).toBe(COMPACT_CATALOG.length);
    expect(compact.toolCount).toBeLessThanOrEqual(20);
    expect(compact.fullToolCount).toBe(TOOL_CATALOG.length);
    expect(compact.defaultLiveToolCount).toBe(20);
    expect(compact.defaultLiveFullToolCount).toBe(144);
    expect(compact.optionalMcpFeatures.subagents).toMatchObject({
      default: false,
      operations: ['subagent_spawn', 'subagent_status', 'subagent_result', 'subagent_control'],
    });
    expect(compact.tools.map((t) => t.name)).toEqual(COMPACT_CATALOG.map((t) => t.name));
    expect(compact.tools.find((t) => t.name === 'dodo_mobile')?.operations).toEqual([
      'android_status', 'android_devices', 'android_device_info', 'android_capture', 'android_ui',
      'android_logcat', 'android_packages', 'android_file_read', 'android_action', 'android_app',
      'android_install', 'android_push', 'android_adb',
    ]);
    for (const t of compact.tools) expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    expect(compact.stats.compact.schemaBytes).toBeLessThan(compact.stats.full.schemaBytes * 0.5);
    // the installed tarball can actually serve the compact surface over STDIO
    const root = fs.mkdtempSync(path.join(workDir, 'compact-root-'));
    const cfg = fs.mkdtempSync(path.join(workDir, 'compact-cfg-'));
    const client = new Client({ name: 'packed-compact-client', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [installedBin, 'stdio', '--tools', 'compact'], cwd: root, env: { ...process.env, DODO_CONFIG_DIR: cfg } as Record<string, string>, stderr: 'pipe' }));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(COMPACT_CATALOG.map((t) => t.name));
      const overview = await client.callTool({ name: 'project_overview', arguments: {} });
      const envelope = overview.structuredContent as { workspaceId: string; workspaceEpoch: string };
      const memory = await client.callTool({ name: 'dodo_assist_read', arguments: {
        workspaceId: envelope.workspaceId, workspaceEpoch: envelope.workspaceEpoch,
        operation: 'memory_status', args: {},
      } });
      expect(memory.structuredContent).toMatchObject({ ok: true, data: { schemaVersion: 1, memories: { current: 0, stale: 0 } } });
      const mobile = await client.callTool({ name: 'dodo_mobile', arguments: {
        workspaceId: envelope.workspaceId, workspaceEpoch: envelope.workspaceEpoch,
        operation: 'android_status', args: {},
      } });
      expect(mobile.structuredContent).toMatchObject({ ok: true, data: { policy: { mode: 'off' } } });
      const runtime = await client.callTool({ name: 'dodo_assist_change', arguments: {
        workspaceId: envelope.workspaceId, workspaceEpoch: envelope.workspaceEpoch,
        operation: 'runtime_session_open', args: { label: 'packed runtime' },
      } });
      expect(runtime.structuredContent).toMatchObject({ ok: true, data: { schemaVersion: 1, status: 'OPEN' } });
      const agent = await client.callTool({ name: 'dodo_assist_change', arguments: {
        workspaceId: envelope.workspaceId, workspaceEpoch: envelope.workspaceEpoch,
        operation: 'agent_run_open', args: {
          goal: 'packed agent runtime', completionCriteria: ['explicit owner verification'],
          capabilities: {
            allowedProjectIds: [], writablePaths: [], allowedPrograms: [], allowNetwork: false,
            allowBrowser: false, allowDesktop: false, allowMedia: false, allowWorkflow: false,
            secretAccess: false, maxHypotheses: 1, maxActions: 5, maxRunningJobs: 1, maxWallMinutes: 5,
          },
        },
      } });
      expect(agent.structuredContent).toMatchObject({ ok: true, data: { schemaVersion: 1, status: 'ACTIVE', authority: 'coordination_only' } });
    } finally { await client.close(); }
  }, 120_000);

  it('PACK-15: fresh installed compact server retrieves source-verified context', async () => {
    const root = fs.mkdtempSync(path.join(workDir, 'context-root-'));
    const cfg = fs.mkdtempSync(path.join(workDir, 'context-cfg-'));
    fs.writeFileSync(path.join(root, 'packed-context.ts'), 'export const packedContextNeedle = 42;\n');
    const client = new Client({ name: 'packed-context-client', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [installedBin, 'stdio', '--tools', 'compact'], cwd: root, env: { ...process.env, DODO_CONFIG_DIR: cfg } as Record<string, string>, stderr: 'pipe' }));
    try {
      const overview = (await client.callTool({ name: 'project_overview', arguments: {} })).structuredContent as { workspaceId: string; workspaceEpoch: string };
      const result = await client.callTool({ name: 'dodo_assist_read', arguments: {
        workspaceId: overview.workspaceId, workspaceEpoch: overview.workspaceEpoch,
        operation: 'context_query', args: { goal: 'packedContextNeedle', terms: ['packedContextNeedle'] },
      } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain('packed-context.ts');
      expect(JSON.stringify(result.structuredContent)).toContain('untrusted_content');
    } finally { await client.close(); }
  }, 120_000);

  it('PACK-17: installed compact MCP backs up and restores registered source with retry receipt; no backup state is packaged', async () => {
    for (const file of ['dist/services/recovery/recoveryService.js','dist/services/recovery/storage.js','dist/services/recovery/contracts.js','dist/services/recovery/evidence.js']) expect(fileList).toContain(file);
    expect(fileList.some(f => /(?:^|\/)recovery\/(?:objects|staging|manifests)\//.test(f))).toBe(false);
    const root = fs.mkdtempSync(path.join(workDir,'recovery-root-'));
    const cfg = fs.mkdtempSync(path.join(workDir,'recovery-config-'));
    fs.writeFileSync(path.join(root,'sample.txt'),'before');
    const env = { ...process.env, DODO_CONFIG_DIR: cfg } as Record<string,string>;
    execFileSync(process.execPath,[installedBin,'project','add',fs.realpathSync(root),'--name','Recovery fixture','--access','full','--json'],{cwd:root,env,stdio:'pipe'});
    const client = new Client({name:'packed-recovery-client',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[installedBin,'stdio','--tools','compact'],cwd:root,env,stderr:'pipe'}));
    try {
      const context=(await client.callTool({name:'project_overview',arguments:{}})).structuredContent as {workspaceId:string;workspaceEpoch:string};
      const result=await client.callTool({name:'dodo_write',arguments:{workspaceId:context.workspaceId,workspaceEpoch:context.workspaceEpoch,operation:'edit_file',args:{path:'sample.txt',edits:[{find:'before',replace:'after'}]}}});
      expect(result.isError,JSON.stringify(result.structuredContent)).not.toBe(true);
      expect(fs.readFileSync(path.join(root,'sample.txt'),'utf8')).toBe('after');
      const objects=path.join(cfg,'recovery','objects');
      expect(fs.readdirSync(objects).some(name=>fs.readFileSync(path.join(objects,name),'utf8')==='before')).toBe(true);
      const status=(await client.callTool({name:'project_overview',arguments:{}})).structuredContent;
      expect(status).toMatchObject({ok:true,data:{recovery:{enabled:true,state:'READY',sourceOnly:true}}});
      const gateway=async(name:string,operation:string,args:Record<string,unknown>)=>{
        const r=await client.callTool({name,arguments:{workspaceId:context.workspaceId,workspaceEpoch:context.workspaceEpoch,operation,args}});
        expect(r.isError,JSON.stringify(r.structuredContent)).not.toBe(true);return (r.structuredContent as {data:Record<string,unknown>}).data;
      };
      const history=await gateway('dodo_read','checkpoint_list',{}),checkpoint=(history.items as Array<{id:string}>)[0]!;
      const plan=await gateway('dodo_write','restore_preview',{checkpointId:checkpoint.id});expect(plan.applicable).toBe(true);
      const args={planId:plan.planId,planHash:plan.planHash,idempotencyKey:'packed-restore-retry'};
      const restored=await gateway('dodo_write','restore_apply',args);expect(restored.verified).toBe(true);expect(fs.readFileSync(path.join(root,'sample.txt'),'utf8')).toBe('before');
      expect((await gateway('dodo_write','restore_apply',args)).changesetId).toBe(restored.changesetId);
    } finally { await client.close(); }
  },120000);

  it('PACK-06: generated schemas match the current handlers (tool count, additionalProperties:false)', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/tools.json'), 'utf8')) as { toolCount: number; tools: Array<{ name: string; inputSchema: { additionalProperties: unknown } }> };
    expect(schema.toolCount).toBe(TOOL_CATALOG.length);
    expect(schema.tools.map((t) => t.name)).toEqual(TOOL_CATALOG.map((t) => t.name));
    for (const t of schema.tools) expect(t.inputSchema.additionalProperties).toBe(false);
  });

  it('PACK-01: the working tree has no stray secret files that would be packaged', () => {
    // Guard against accidental commit of runtime state into the repo root.
    for (const name of ['state.db', '.env', 'jwks.json']) {
      expect(fs.existsSync(path.join(ROOT, name)), name).toBe(false);
    }
  });
});
