import { SUBAGENT_TOOLS } from './subagentTools.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerTool, type AnyToolDef, type AppServices } from './context.js';
import { CORE_TOOL_CATALOG } from './coreCatalog.js';
import { AGENT_RUNTIME_TOOLS } from './agentRuntimeTools.js';

/**
 * The tool catalog in a FIXED, stable order. Every listed tool is fully
 * implemented; nothing here is a stub, and no roadmap tool is registered.
 *
 * Tiers share one policy and one journal:
 *  - understand: overview / list / read / search / glob / images / instructions
 *  - direct edits: write / edit / patch / bulk replace / delete / move / mkdir
 *  - semantics: TS/JS built in, other languages via owner-registered LSP
 *  - reviewed changes: preview_* → apply_changes → rollback
 *  - git: status / diff / log / commit
 *  - run: run_command(s) (shell, parallel, background, sandbox) + job_* polling,
 *    run_task recipes, exec_command (argv)
 *  - agent workflow: todo, environment, fetch_url, diagnostics, handoff
 */
export const TOOL_CATALOG: AnyToolDef[] = [
  ...CORE_TOOL_CATALOG,
  // Durable plan/hypothesis/lock/snapshot/skill coordination. Existing 104 names stay an exact prefix.
  ...AGENT_RUNTIME_TOOLS,
  ...SUBAGENT_TOOLS,
];

export function registerCatalog(server: McpServer, services: AppServices): void {
  for (const def of TOOL_CATALOG) {
    registerTool(server, services, def);
  }
}
