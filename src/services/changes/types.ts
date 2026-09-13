/** Change-plan data contract (spec §12.1). Plans are immutable once created. */

export type PublicPlanOp =
  | { op: 'create'; path: string; content: string; createParents?: boolean }
  | { op: 'replace_file'; path: string; content: string; expectedHash?: string }
  | { op: 'replace_exact'; path: string; find: string; replace: string; expectedCount?: number; expectedHash?: string }
  | { op: 'delete'; path: string; expectedHash?: string }
  | { op: 'move'; path: string; destPath: string; expectedHash?: string };

/** Internal-only op used by preview_rename (positional span edits). */
export interface SpanEditOp {
  op: 'span_edit';
  path: string;
  edits: Array<{ start: number; end: number; newText: string }>; // byte offsets in original
}

export type AnyPlanOp = PublicPlanOp | SpanEditOp;

export interface PlanFileChange {
  path: string;
  destPath?: string;
  action: 'create' | 'modify' | 'delete' | 'move';
  beforeHash: string | null; // sha256 of raw bytes; null for create
  afterHash: string | null; // null for delete
  /** base64 of complete new content for create/modify; absent for delete/move. */
  afterContentB64?: string;
  /** file mode to preserve on modify (from the original file). */
  mode?: number;
  /** directories that must be created (in order) before writing. */
  createParents?: string[];
  diff: string;
  diffTruncated: boolean;
  bytesBefore: number;
  bytesAfter: number;
}

export interface StoredPlan {
  version: 1;
  workspaceId: string;
  epoch: string;
  principal: string;
  source: 'preview_changes' | 'preview_rename' | 'direct';
  files: PlanFileChange[];
  summary: string;
}

export interface PlanPreviewResult {
  planId: string;
  planHash: string;
  expiresAt: number;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  files: Array<Pick<PlanFileChange, 'path' | 'destPath' | 'action' | 'beforeHash' | 'afterHash' | 'diff' | 'diffTruncated' | 'bytesBefore' | 'bytesAfter'>>;
}

export interface FileConflict {
  path: string;
  reason: string;
}
