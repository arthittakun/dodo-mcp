import { MULTIMODAL_TOOLS } from './multimodalTools.js';
import { contextForTaskTool, analyzeImpactTool, readSymbolTool, previewRefactorTool, verifyChangesTool } from './assistanceTools.js';
import { scheduleProposeTool } from './scheduleTools.js';
import { desktopStatusTool, desktopWindowsTool, desktopCaptureTool, desktopAccessibilityTool, desktopActionTool } from './desktopTools.js';
import type { AnyToolDef } from './context.js';
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
import { RUNTIME_TOOLS } from './runtimeTools.js';

/** Stable pre-Phase-09 catalog. Advanced-agent dispatch may target this list only. */
export const CORE_TOOL_CATALOG: AnyToolDef[] = [
  projectOverviewTool,
  listFilesTool,
  readFilesTool,
  readImageTool,
  readInstructionsTool,
  searchCodeTool,
  globFilesTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  replaceInFilesTool,
  deletePathTool,
  movePathTool,
  makeDirectoryTool,
  symbolsTool,
  referencesTool,
  previewRenameTool,
  previewChangesTool,
  applyChangesTool,
  rollbackChangesTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
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
  contextForTaskTool,
  analyzeImpactTool,
  readSymbolTool,
  previewRefactorTool,
  verifyChangesTool,
  ...CONTEXT_TOOLS,
  ...MEMORY_TOOLS,
  ...RUNTIME_TOOLS,
  ...BRAIN_TOOLS,
  ...MULTIMODAL_TOOLS,
  ...RESOURCE_TOOLS,
];
