import { instructionsFor } from './instructions.js';
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ipcSocketPath } from '../config/paths.js';
import { ALL_SCOPES } from '../security/policy.js';
import { registerSurface, surfaceStats, type ToolSurface } from '../tools/surface.js';
import { startOwnerControl } from '../ipc/ownerControl.js';
import { bootstrapWorkspace } from './bootstrap.js';
import { createIpcDispatcher } from './ipcDispatch.js';
import { attachOptionalServices } from './optionalServices.js';
import { DODO_VERSION } from './version.js';

/**
 * The stdio entry (`dodo stdio`): serves MCP over the current process's
 * stdin/stdout for LOCAL clients (Claude Code, Cursor, Claude Desktop, Codex
 * CLI, ...). No tunnel, no OAuth: the client is a process started by the same
 * OS user in the same session, so it IS the owner's principal. Trust modes
 * and local approvals still apply unchanged. stdout is reserved for the
 * protocol — every log line goes to stderr.
 */
export interface StdioOptions {
  invokedCwd: string;
  rootOverride?: string;
  allowUnsafeRoot?: boolean;
  /** Tool exposure for this run; overrides config.toolSurface. STDIO default: 'full'. */
  toolSurface?: ToolSurface;
  onLog?: (line: string) => void;
  onStopped?: () => void;
}

export interface RunningStdioServer {
  root: string;
  workspaceId: string;
  epoch: string;
  ipcPath: string;
  close(): Promise<void>;
}

export const STDIO_PRINCIPAL = {
  grantId: 'local-stdio',
  clientId: 'stdio',
  sub: 'owner',
  scopes: [...ALL_SCOPES],
};

export async function startStdioServer(opts: StdioOptions): Promise<RunningStdioServer> {
  const log = opts.onLog ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ws = bootstrapWorkspace({
    invokedCwd: opts.invokedCwd,
    ...(opts.rootOverride !== undefined ? { rootOverride: opts.rootOverride } : {}),
    allowUnsafeRoot: opts.allowUnsafeRoot ?? false,
    log,
  });
  attachOptionalServices(ws, log);
  ws.services.localPrincipal = { ...STDIO_PRINCIPAL, scopes: [...STDIO_PRINCIPAL.scopes] };

  // STDIO keeps the FULL per-tool catalog by default: local clients (Codex,
  // Claude Code, Cursor) rely on the individual tool contract (ADR-029).
  const surface: ToolSurface = opts.toolSurface ?? ws.config.toolSurface ?? 'full';
  const factory: McpServerFactory = () => {
    const server = new McpServer({ name: 'dodo', version: DODO_VERSION, title: 'DODO workspace server (stdio)' }, { instructions: instructionsFor(surface) });
    registerSurface(server, ws.services, surface);
    return server;
  };
  const handle = serveStdio(factory, {
    legacy: 'serve',
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: ws.services.limits.requestBodyBytes }),
    onerror: (err) => log(`[dodo] mcp: ${err.message}`),
  });

  const ipcPath = ipcSocketPath(ws.configDir, ws.workspaceId);
  const ownerControl = await startOwnerControl(
    ws,
    createIpcDispatcher({
      ws,
      transport: { kind: 'stdio', port: 0, locked: false, publicUrl: null },
      requestStop: () => void close(),
    }),
  );

  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (!closePromise) {
      const jobsClosed = ws.services.jobs.shutdown(3000);
      closePromise = (async () => {
        try { await handle.close(); } catch { /* transport may already be gone */ }
        await jobsClosed;
        await ownerControl.close();
        await ws.shutdownServices();
        opts.onStopped?.();
      })();
    }
    return closePromise;
  }

  {
    const stats = surfaceStats(surface);
    log(`[dodo] mcp tool surface | transport=stdio | surface=${surface} | tools=${stats.toolCount} | schemaBytes=${stats.schemaBytes}`);
  }
  log(`[dodo] stdio  |  workspace ${ws.rootInfo.root}  |  ${ws.workspaceId}  |  policy ${ws.services.trustMode()}  |  state ${ws.configDir}`);
  return { root: ws.rootInfo.root, workspaceId: ws.workspaceId, epoch: ws.epoch, ipcPath, close };
}
