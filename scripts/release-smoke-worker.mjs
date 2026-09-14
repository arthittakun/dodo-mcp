#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { npmInvocation } from './npm-process.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function parseArgs() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--tarball' && process.argv[i + 1]) out.tarball = path.resolve(process.argv[++i]);
    else if (process.argv[i] === '--output' && process.argv[i + 1]) out.output = path.resolve(process.argv[++i]);
    else if (process.argv[i] === '--fixture-dir' && process.argv[i + 1]) out.fixtureDir = path.resolve(process.argv[++i]);
    else throw new Error(`unknown argument: ${process.argv[i]}`);
  }
  if (!out.tarball || !out.output || !out.fixtureDir) throw new Error('internal smoke worker requires --tarball, --output and --fixture-dir');
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); });
    server.on('error', reject);
  });
}

class Cookies {
  values = new Map();
  absorb(response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0]; const index = pair.indexOf('=');
      if (index > 0) this.values.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  header() { return [...this.values].map(([key, value]) => `${key}=${value}`).join('; '); }
}

async function oauthToken({ baseUrl, redirectUri, store, addStaticClient }) {
  const registered = addStaticClient(store, { redirectUris: [redirectUri], name: 'release smoke client' });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const cookies = new Cookies();
  const auth = new URL(`${baseUrl}/auth`);
  for (const [key, value] of Object.entries({ client_id: registered.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'dodo:read dodo:write dodo:exec offline_access', state: randomBytes(8).toString('hex'), code_challenge: challenge, code_challenge_method: 'S256', resource: `${baseUrl}/mcp` })) auth.searchParams.set(key, value);
  const first = await fetch(auth, { redirect: 'manual' }); cookies.absorb(first);
  if (![302, 303].includes(first.status)) throw new Error(`OAuth authorization failed (${first.status})`);
  const location = first.headers.get('location');
  const interactionUrl = new URL(location, baseUrl); const uid = interactionUrl.pathname.split('/').at(-1);
  const page = await fetch(interactionUrl, { headers: { cookie: cookies.header() }, redirect: 'manual' }); cookies.absorb(page);
  if (page.status !== 200 || !uid || !store.setApprovalStatus(uid, 'approved')) throw new Error('OAuth owner approval fixture failed');
  const complete = await fetch(`${baseUrl}/interaction/${uid}/complete`, { method: 'POST', headers: { cookie: cookies.header(), 'x-dodo-interaction': uid } }); cookies.absorb(complete);
  const completion = await complete.json();
  if (!completion.returnTo) throw new Error('OAuth interaction completion failed');
  const resume = await fetch(completion.returnTo, { headers: { cookie: cookies.header() }, redirect: 'manual' });
  const callback = new URL(resume.headers.get('location'));
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('OAuth callback omitted authorization code');
  const token = await fetch(`${baseUrl}/token`, { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${registered.clientId}:${registered.clientSecret}`).toString('base64')}`,
  }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, resource: `${baseUrl}/mcp` }) });
  const body = await token.json();
  if (token.status !== 200 || typeof body.access_token !== 'string') throw new Error(`OAuth token exchange failed (${token.status})`);
  return body.access_token;
}

function envelope(result) {
  const value = result.structuredContent;
  if (!value || value.ok !== true) throw new Error(`MCP tool failed: ${value?.error?.code ?? 'missing envelope'}`);
  return value;
}

const args = parseArgs();
const install = path.join(args.fixtureDir, 'install');
const workspace = path.join(args.fixtureDir, 'workspace');
const config = path.join(args.fixtureDir, 'config');
for (const directory of [install, workspace, config]) fs.mkdirSync(directory);
let running;
let stdio;
let httpClient;
try {
  fs.writeFileSync(path.join(workspace, 'seed.txt'), 'seed\n');
  const npm = npmInvocation(['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', args.tarball]);
  const installed = spawnSync(npm.program, npm.args, { encoding: 'utf8', stdio: 'pipe', timeout: 5 * 60 * 1000, windowsHide: true });
  if (installed.error || installed.status !== 0) throw new Error(`fresh npm install failed (${installed.status}): ${installed.stderr}`);
  const packageRoot = path.join(install, 'node_modules', 'dodo-mcp');
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const cli = path.join(packageRoot, 'dist', 'cli', 'main.js');
  const versionRun = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (versionRun.status !== 0 || versionRun.stdout.trim() !== packageJson.version) throw new Error('installed CLI version smoke failed');

  const stdioClient = new Client({ name: 'release-stdio-smoke', version: '1' });
  stdio = new StdioClientTransport({ command: process.execPath, args: [cli, 'stdio'], cwd: workspace, env: { ...process.env, DODO_CONFIG_DIR: config }, stderr: 'pipe' });
  await stdioClient.connect(stdio);
  const fullCount = (await stdioClient.listTools()).tools.length;
  const stdioOverview = envelope(await stdioClient.callTool({ name: 'project_overview', arguments: {} }));
  await stdioClient.close(); stdio = undefined;

  const [{ startServer }, configModule, pathsModule, clientModule] = await Promise.all([
    import(pathToFileURL(path.join(packageRoot, 'dist/server/appServer.js')).href),
    import(pathToFileURL(path.join(packageRoot, 'dist/config/globalConfig.js')).href),
    import(pathToFileURL(path.join(packageRoot, 'dist/config/paths.js')).href),
    import(pathToFileURL(path.join(packageRoot, 'dist/auth/clients.js')).href),
  ]);
  const port = await freePort(); const baseUrl = `http://127.0.0.1:${port}`;
  fs.mkdirSync(config, { recursive: true });
  const paths = pathsModule.statePaths(config);
  configModule.saveGlobalConfig(paths.configFile, configModule.GlobalConfigSchema.parse({ publicUrl: baseUrl, port, dangerouslyAllowInsecurePublicUrl: true }));
  const previous = process.env.DODO_CONFIG_DIR; process.env.DODO_CONFIG_DIR = config;
  try { running = await startServer({ invokedCwd: workspace, portOverride: port, quiet: true, toolSurface: 'compact' }); }
  finally { if (previous === undefined) delete process.env.DODO_CONFIG_DIR; else process.env.DODO_CONFIG_DIR = previous; }
  running.services.store.setTrustMode(running.workspaceId, 'trusted');
  const accessToken = await oauthToken({ baseUrl, redirectUri: 'http://127.0.0.1:19998/dodo-release-smoke', store: running.services.store, addStaticClient: clientModule.addStaticClient });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: { token: async () => accessToken } });
  httpClient = new Client({ name: 'release-http-smoke', version: '1' });
  await httpClient.connect(transport);
  const compactCount = (await httpClient.listTools()).tools.length;
  const overview = envelope(await httpClient.callTool({ name: 'project_overview', arguments: {} }));
  const context = { workspaceId: overview.workspaceId, workspaceEpoch: overview.workspaceEpoch };
  envelope(await httpClient.callTool({ name: 'dodo_write', arguments: { ...context, operation: 'write_file', args: { path: 'smoke.txt', content: 'alpha\n' } } }));
  const read1 = envelope(await httpClient.callTool({ name: 'dodo_read', arguments: { ...context, operation: 'read_files', args: { files: [{ path: 'smoke.txt' }] } } }));
  const firstFile = read1.data.files[0];
  envelope(await httpClient.callTool({ name: 'dodo_write', arguments: { ...context, operation: 'edit_file', args: { path: 'smoke.txt', expectedHash: firstFile.hash ?? firstFile.sha256, edits: [{ find: 'alpha', replace: 'beta' }] } } }));
  const read2 = envelope(await httpClient.callTool({ name: 'dodo_read', arguments: { ...context, operation: 'read_files', args: { files: [{ path: 'smoke.txt' }] } } }));
  if (read2.data.files[0].content !== 'beta\n') throw new Error('installed compact write/edit read-back failed');
  const report = { schemaVersion: 1, status: 'PASS', package: { name: packageJson.name, version: packageJson.version },
    cliVersion: versionRun.stdout.trim(), stdio: { surface: 'full', toolCount: fullCount, overviewOk: stdioOverview.ok === true },
    http: { transport: 'streamable-http', oauth: true, surface: 'compact', toolCount: compactCount, writeEditReadBack: true },
    installation: { source: 'exact-tarball', freshPrefix: true, freshConfig: true }, generatedAt: new Date().toISOString() };
  if (fullCount !== 121 || compactCount !== 19) throw new Error(`surface count mismatch: full=${fullCount} compact=${compactCount}`);
  fs.mkdirSync(path.dirname(args.output), { recursive: true }); fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
} finally {
  if (httpClient) await httpClient.close().catch(() => undefined);
  if (stdio) await stdio.close().catch(() => undefined);
  if (running) await running.close().catch(() => undefined);
  // Native modules stay mapped until this process exits, even after closing
  // SQLite/services. The parent owns directory cleanup after worker exit.
}
