import type { TrustMode } from '../store/store.js';

/**
 * Authority model (spec §8.5, §9): real power is the INTERSECTION of
 *  - OAuth token scope (dodo:read / dodo:write / dodo:exec)
 *  - workspace grant binding (checked in auth verifier)
 *  - local trust mode (inspect / edit / trusted)
 * plus per-action local approvals where the matrix requires them.
 */

export type OAuthScope = 'dodo:read' | 'dodo:write' | 'dodo:exec';
export const ALL_SCOPES: OAuthScope[] = ['dodo:read', 'dodo:write', 'dodo:exec'];

/** Local action classes used by the trust-mode matrix. */
export type ActionClass =
  | 'read' // read/search/status — allowed in every mode
  | 'plan' // preview_* — creates internal plans, no workspace mutation
  | 'mutate-files' // apply_changes / rollback_changes
  | 'exec' // run_task / exec_command / job_input
  | 'job-control'; // job_cancel — stopping owned work is always allowed

export type PolicyDecision = 'allow' | 'approval';

export function decide(action: ActionClass, mode: TrustMode): PolicyDecision {
  switch (action) {
    case 'read':
    case 'plan':
    case 'job-control':
      return 'allow';
    case 'mutate-files':
      return mode === 'inspect' ? 'approval' : 'allow';
    case 'exec':
      return mode === 'trusted' ? 'allow' : 'approval';
  }
}

export function scopeSatisfied(required: OAuthScope, tokenScopes: string[]): boolean {
  return tokenScopes.includes(required);
}

export const TRUST_MODE_DESCRIPTIONS: Record<TrustMode, string> = {
  inspect: 'read & search allowed; every file change (write_file/edit_file/apply_changes) and every command (run_command/exec_command/run_task/git_commit) needs a per-action local approval',
  edit: 'read & search allowed; file changes (write_file/edit_file/delete_path/move_path/apply_changes) apply directly under this standing consent; running commands still needs per-action local approval',
  trusted:
    'file changes and command execution (run_command/exec_command/run_task/git_commit) run directly — the recommended mode when your MCP client confirms every call. Commands run with YOUR OS user privileges — the workspace directory guard is NOT an OS sandbox; test/lint/build scripts can execute arbitrary code and reach files outside the workspace',
};
