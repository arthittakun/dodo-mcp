import { MULTIMODAL_TOOLS } from './multimodalTools.js';
import { contextForTaskTool, analyzeImpactTool, readSymbolTool, previewRefactorTool, verifyChangesTool } from './assistanceTools.js';
import { scheduleProposeTool } from './scheduleTools.js';
import { desktopStatusTool, desktopWindowsTool, desktopCaptureTool, desktopAccessibilityTool, desktopActionTool } from './desktopTools.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerTool, type AnyToolDef, type AppServices } from './context.js';
import { projectOverviewTool, listFilesTool, readFilesTool, searchCodeTool } from './projectTools.js';
import { globFilesTool, writeFileTool, editFileTool, deletePathTool, movePathTool, makeDirectoryTool } from './directTools.js';
import { applyPatchTool, replaceInFilesTool, readImageTool, readInstructionsTool } from './extraTools.js';
import { symbolsTool, referencesTool, previewRenameTool } from './semanticTools.js';
import { previewChangesTool, applyChangesTool, rollbackChangesTool, changeHistoryTool } from './changeTools.js';
import { gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool } from './gitTools.js';
import { runCommandTool, runCommandsTool, execCommandTool, runTaskTool, jobStatusTool, jobOutputTool, jobWaitTool, jobInputTool, jobCancelTool, listJobsTool } from './jobTools.js';
import { diagnosticsTool, approvalStatusTool, handoffWriteTool, handoffReadTool } from './metaTools.js';
import { todoWriteTool, todoReadTool, environmentInfoTool, fetchUrlTool } from './agentTools.js';
import { RESOURCE_TOOLS } from './resourceTools.js';
import { BRAIN_TOOLS } from './brainTools.js';
import { CONTEXT_TOOLS } from './contextTools.js';
import { MEMORY_TOOLS } from './memoryTools.js';

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
  // understand
  projectOverviewTool,
  listFilesTool,
  readFilesTool,
  readImageTool,
  readInstructionsTool,
  searchCodeTool,
  globFilesTool,
  // direct edits
  writeFileTool,
  editFileTool,
  applyPatchTool,
  replaceInFilesTool,
  deletePathTool,
  movePathTool,
  makeDirectoryTool,
  // semantics
  symbolsTool,
  referencesTool,
  previewRenameTool,
  // reviewed changes
  previewChangesTool,
  applyChangesTool,
  rollbackChangesTool,
  // git
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  // run
  runCommandTool,
  runCommandsTool,
  runTaskTool,
  execCommandTool,
  jobStatusTool,
  jobOutputTool,
  jobWaitTool,
  jobInputTool,
  jobCancelTool,
  listJobsTool,
  // agent workflow / evidence
  environmentInfoTool,
  todoWriteTool,
  todoReadTool,
  fetchUrlTool,
  diagnosticsTool,
  changeHistoryTool,
  approvalStatusTool,
  handoffReadTool,
  handoffWriteTool,
  desktopStatusTool,
  desktopWindowsTool,
  desktopCaptureTool,
  desktopAccessibilityTool,
  desktopActionTool,
  scheduleProposeTool,
  // Additive task assistance; existing catalog order and policy remain intact.
  contextForTaskTool,
  analyzeImpactTool,
  readSymbolTool,
  previewRefactorTool,
  verifyChangesTool,
  // Goal-driven context, evidence revalidation and caller-scoped diagnostics.
  ...CONTEXT_TOOLS,
  // Evidence-backed durable memory; all permanence and learning require owner review.
  ...MEMORY_TOOLS,
  // Incremental, source-verified project structure and relationship index.
  ...BRAIN_TOOLS,
  // Optional local media/browser/game/workflow capabilities under the existing scopes.
  ...MULTIMODAL_TOOLS,
  // Universal immutable resources and content-addressed storage.
  ...RESOURCE_TOOLS,
];

export function registerCatalog(server: McpServer, services: AppServices): void {
  for (const def of TOOL_CATALOG) {
    registerTool(server, services, def);
  }
}
