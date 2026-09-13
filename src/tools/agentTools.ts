import { z } from 'zod';
import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { policyGate, defineTool } from './context.js';
import { DodoError } from '../errors.js';
import { redact } from '../security/redact.js';
import { buildChildEnv } from '../security/env.js';
import { resolveTrustedExecutable } from '../platform/execResolve.js';
import { batchInvocation, shellSpec } from '../platform/shell.js';
import { signalOwnedProcess } from '../platform/processTree.js';
import { truncateUtf8 } from '../util/bytes.js';

/**
 * Agent-workflow tools: a per-workspace todo list (Claude Code / OpenCode
 * TodoWrite-style planning memory), toolchain discovery, and a SSRF-guarded
 * URL fetch (opt-in via global config).
 */
const looseData = z.looseObject({});

const TodoSchema = z
  .object({
    id: z.string().min(1).max(64),
    content: z.string().min(1).max(500),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
  })
  .strict();

export const todoWriteTool = defineTool({
  name: 'todo_write',
  title: 'Write todo list',
  description:
    'Replace the workspace todo list (your working plan). Keep it short; mark exactly one item in_progress at a time; update as you finish steps. Stored in DODO state outside the repo, visible to the next session via todo_read. Data only — grants nothing.',
  input: { todos: z.array(TodoSchema).max(100) },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'plan',
  handler: async (args, ctx) => {
    const payload = redact(JSON.stringify(args.todos));
    ctx.services.store.setTodos(ctx.services.workspaceId, ctx.principal.grantId, payload);
    return { data: { count: args.todos.length, inProgress: args.todos.filter((t) => t.status === 'in_progress').length, updatedAt: Date.now() } };
  },
});

export const todoReadTool = defineTool({
  name: 'todo_read',
  title: 'Read todo list',
  description: 'Read the current workspace todo list written by todo_write (untrusted prior-session data; a plan, not permissions).',
  input: {},
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (_args, ctx) => {
    const row = ctx.services.store.getTodos(ctx.services.workspaceId);
    if (!row) return { data: { todos: [], updatedAt: null } };
    return { data: { todos: JSON.parse(row.payload) as unknown, updatedAt: row.updatedAt } };
  },
});

const PROBES: Array<{ name: string; bin: string; args: string[] }> = [
  { name: 'node', bin: 'node', args: ['--version'] },
  { name: 'npm', bin: 'npm', args: ['--version'] },
  { name: 'pnpm', bin: 'pnpm', args: ['--version'] },
  { name: 'yarn', bin: 'yarn', args: ['--version'] },
  { name: 'bun', bin: 'bun', args: ['--version'] },
  { name: 'python3', bin: 'python3', args: ['--version'] },
  { name: 'pip3', bin: 'pip3', args: ['--version'] },
  { name: 'go', bin: 'go', args: ['version'] },
  { name: 'cargo', bin: 'cargo', args: ['--version'] },
  { name: 'rustc', bin: 'rustc', args: ['--version'] },
  { name: 'java', bin: 'java', args: ['-version'] },
  { name: 'ruby', bin: 'ruby', args: ['--version'] },
  { name: 'git', bin: 'git', args: ['--version'] },
  { name: 'rg', bin: 'rg', args: ['--version'] },
  { name: 'docker', bin: 'docker', args: ['--version'] },
  { name: 'make', bin: 'make', args: ['--version'] },
];

let envCache: { at: number; root: string; value: Record<string, string | null> } | undefined;

function probe(bin: string, args: string[], env: NodeJS.ProcessEnv, root: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      const executable = resolveTrustedExecutable(bin, root, { env });
      const call = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
        ? batchInvocation(executable, args, root)
        : { program: executable, args, windowsVerbatimArguments: false };
      child = spawn(call.program, call.args, { cwd: root, env, shell: false, windowsHide: true, windowsVerbatimArguments: call.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try { signalOwnedProcess(child, 'SIGKILL'); } catch { /* unavailable, never a successful probe */ }
      resolve(null);
    }, 4000);
    timer.unref();
    child.stdout.on('data', (c: Buffer) => chunks.length < 8 && chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.length < 8 && chunks.push(c)); // java prints to stderr
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const first = Buffer.concat(chunks).toString('utf8').split('\n')[0] ?? '';
      resolve(first.trim().slice(0, 120) || null);
    });
  });
}

export const environmentInfoTool = defineTool({
  name: 'environment_info',
  title: 'Environment info',
  description:
    'Which toolchains are available on this machine (node/npm/pnpm/yarn/bun/python/pip/go/cargo/rustc/java/ruby/git/rg/docker/make versions), OS/arch, shell, and the sandbox/LSP capabilities DODO has configured — so you can pick the right commands without guessing. Probes run `--version` on the trusted PATH only.',
  input: {},
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (_args, ctx) => {
    const s = ctx.services;
    if (!envCache || envCache.root !== s.wfs.root || Date.now() - envCache.at > 60_000) {
      const env = buildChildEnv({ parentEnv: process.env, workspaceRoot: s.wfs.root, extraAllowlist: [] });
      const results = await Promise.all(PROBES.map(async (p) => [p.name, await probe(p.bin, p.args, env, s.wfs.root)] as const));
      envCache = { at: Date.now(), root: s.wfs.root, value: Object.fromEntries(results) };
    }
    return {
      data: {
        os: process.platform,
        release: os.release(),
        arch: process.arch,
        cpus: os.cpus().length,
        shell: s.jobs.shellPath(),
        shellKind: shellSpec(s.wfs.root).kind,
        windowsNative: process.platform === 'win32' ? { status: 'supported', ipc: 'authenticated-named-pipe', cancellation: 'owned-tree-hard-kill', sandbox: true, desktop: true, speech: true, readiness: 'dodo setup --check' } : null,
        tools: envCache.value,
        capabilities: {
          searchBackend: s.search.rgAvailable() ? 'ripgrep' : 'js',
          semanticBuiltin: s.intel.available().ok ? ['typescript', 'javascript'] : [],
          lspLanguages: Object.keys(s.config.lsp),
          commandSandbox: s.config.commandSandbox,
          webFetch: s.config.allowWebFetch,
          trustMode: ctx.trustMode,
        },
      },
    };
  },
});

// ---------------------------------------------------------------------------
// fetch_url — SSRF-guarded outbound fetch (opt-in)
// ---------------------------------------------------------------------------
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::' ) return true;
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new DodoError('FORBIDDEN', 'fetch_url refuses local/internal hosts');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new DodoError('FORBIDDEN', 'fetch_url refuses private/loopback addresses');
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new DodoError('NOT_FOUND', `cannot resolve host ${host}`);
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new DodoError('FORBIDDEN', 'fetch_url refuses hosts that resolve to private/loopback addresses');
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const fetchUrlTool = defineTool({
  name: 'fetch_url',
  title: 'Fetch URL',
  description:
    'Fetch a public https:// URL from this machine and return its text (HTML is reduced to readable text; JSON/text returned as-is), bounded by maxBytes. Disabled unless the owner set allowWebFetch in the global config. Refuses localhost, private and link-local addresses (including via DNS and redirects). Gated like a command (trusted mode or approval) because it is outbound network access from your machine. No cookies, no auth headers.',
  input: {
    url: z.string().url().max(2048),
    maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
    timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  requiredScope: 'dodo:read',
  action: 'exec',
  handler: async (args, ctx) => {
    if (!ctx.services.config.allowWebFetch) {
      throw new DodoError('NOT_SUPPORTED', 'fetch_url is disabled; the owner can enable it with "allowWebFetch": true in the global config', {
        recovery: 'ask the machine owner, or use your client\'s own browsing',
      });
    }
    policyGate(ctx, { tool: 'fetch_url', action: 'exec', approvalAction: { url: args.url }, summary: `fetch ${args.url}`.slice(0, 200) });
    let current = new URL(args.url);
    if (current.protocol !== 'https:') throw new DodoError('FORBIDDEN', 'only https:// URLs are allowed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      let res: Response | undefined;
      for (let hop = 0; hop < 5; hop += 1) {
        await assertPublicHost(current.hostname);
        res = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': 'dodo-mcp/1.1 (+fetch_url)', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' },
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) break;
          current = new URL(loc, current);
          if (current.protocol !== 'https:') throw new DodoError('FORBIDDEN', 'redirect to a non-https URL refused');
          continue;
        }
        break;
      }
      if (!res) throw new DodoError('INTERNAL_ERROR', 'no response');
      const contentType = res.headers.get('content-type') ?? '';
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let bodyTruncated = false;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            received += value.length;
            if (received > args.maxBytes) {
              bodyTruncated = true;
              chunks.push(value.subarray(0, Math.max(0, value.length - (received - args.maxBytes))));
              await reader.cancel();
              break;
            }
            chunks.push(value);
          }
        }
      }
      const buf = Buffer.concat(chunks);
      const isText = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml))/i.test(contentType) || contentType === '';
      let text = '';
      if (isText) {
        const raw = buf.toString('utf8');
        text = /text\/html/i.test(contentType) ? htmlToText(raw) : raw;
      }
      const { text: bounded, truncated } = truncateUtf8(text, Math.max(4 * 1024, ctx.services.limits.toolContentBytes - 8 * 1024));
      return {
        data: { url: args.url, finalUrl: current.toString(), status: res.status, contentType, bytes: buf.length, text: bounded, binary: !isText },
        truncated: truncated || bodyTruncated,
      };
    } catch (err) {
      if (err instanceof DodoError) throw err;
      if ((err as Error).name === 'AbortError') throw new DodoError('TIMEOUT', 'fetch timed out', { retryable: true });
      throw new DodoError('INTERNAL_ERROR', `fetch failed: ${redact((err as Error).message).slice(0, 200)}`);
    } finally {
      clearTimeout(timer);
    }
  },
});
