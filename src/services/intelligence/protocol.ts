import type { AssistanceRequest } from '../assistance/contracts.js';

/** Host↔worker protocol for the TypeScript language service (spec §11). */

export interface WorkerInit {
  root: string;
  extraSecretPatterns: string[];
  projectExcludes: string[];
  semanticFilesMax: number;
  maxSnapshotBytes: number;
}

export interface Position {
  line: number; // 1-based
  column: number; // 1-based UTF-16 code units
}

export type WorkerRequest =
  | (AssistanceRequest & { id: number })
  | { id: number; op: 'symbols_file'; file: string; maxItems: number }
  | { id: number; op: 'symbols_query'; query: string; maxItems: number }
  | { id: number; op: 'references'; file: string; position: Position; maxItems: number }
  | { id: number; op: 'rename'; file: string; position: Position; newName: string }
  | { id: number; op: 'diagnostics'; files: string[] | null; maxItems: number };

export interface SymbolInfo {
  name: string;
  kind: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  containerName?: string;
}

export interface ReferenceInfo {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  lineText: string;
  isDefinition: boolean;
  isWriteAccess: boolean;
}

export interface RenameFileEdits {
  path: string;
  edits: Array<{ start: number; end: number; newText: string; originalText: string }>; // byte offsets
}

export interface RenameResultData {
  locations: RenameFileEdits[];
  outOfScopeCount: number;
  outOfScopeSample: string[];
  symbolName: string;
}

export interface DiagnosticInfo {
  path: string;
  line: number;
  column: number;
  category: 'error' | 'warning' | 'suggestion' | 'message';
  code: number;
  message: string;
}

export interface WorkerMeta {
  projectFiles: number;
  degraded: boolean;
  degradedReason?: string;
  programVersion: string;
}

export type WorkerResponse =
  | { id: number; ok: true; data: unknown; meta: WorkerMeta }
  | { id: number; ok: false; error: { code: string; message: string } };
