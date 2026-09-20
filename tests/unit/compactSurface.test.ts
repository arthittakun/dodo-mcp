import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { toolInputShape, type AnyToolDef, type ToolCtx } from '../../src/tools/context.js';
import {
  COMPACT_CATALOG,
  HYBRID_CATALOG,
  HYBRID_DIRECT_OPERATIONS,
  GATEWAY_OPERATIONS,
  OPERATION_TO_GATEWAY,
  operationSchema,
  operationArgsSchema,
  surfaceCatalog,
  surfaceStats,
} from '../../src/tools/surface.js';
import { instructionsFor } from '../../src/server/instructions.js';

/** ADR-029: compact surface invariants — pure catalog logic, no server. */

/** The frozen full-catalog contract: exact names and stable order. */
const FULL_NAMES = [
  'project_overview', 'list_files', 'read_files', 'read_image', 'read_instructions', 'search_code', 'glob_files',
  'write_file', 'edit_file', 'apply_patch', 'replace_in_files', 'delete_path', 'move_path', 'make_directory',
  'symbols', 'references', 'preview_rename', 'preview_changes', 'apply_changes', 'rollback_changes',
  'git_status', 'git_diff', 'git_log', 'git_commit',
  'run_command', 'run_commands', 'run_task', 'exec_command', 'job_status', 'job_output', 'job_wait', 'job_input', 'job_cancel', 'list_jobs',
  'environment_info', 'todo_write', 'todo_read', 'fetch_url', 'diagnostics', 'change_history', 'approval_status', 'handoff_read', 'handoff_write',
  'desktop_status', 'desktop_windows', 'desktop_capture', 'desktop_accessibility', 'desktop_action',
  'schedule_propose',
  'context_for_task', 'analyze_impact', 'read_symbol', 'preview_refactor', 'verify_changes',
  'context_query', 'context_evidence', 'context_status',
  'memory_search', 'memory_inspect', 'memory_status', 'memory_propose', 'memory_learning_propose',
  'runtime_session_open', 'runtime_session_status', 'runtime_session_close', 'runtime_task_start', 'runtime_task_observe',
  'runtime_task_cancel', 'runtime_browser_collect', 'runtime_snapshot', 'runtime_evidence', 'runtime_diagnose',
  'brain_status', 'brain_query', 'brain_symbol', 'brain_rebuild', 'brain_pause', 'brain_cancel',
  'multimodal_status', 'screen_observe', 'image_view', 'media_open', 'media_extract', 'media_transcribe',
  'media_subtitles', 'media_search', 'media_read', 'media_job', 'media_close', 'speech_synthesize',
  'browser_session', 'browser_observe', 'browser_action', 'game_session', 'game_step',
  'workflow_save', 'workflow_search', 'workflow_run',
  'resource_inspect', 'resource_read', 'resource_read_range', 'resource_preview', 'resource_extract', 'resource_transform',
  'agent_run_open', 'agent_run_status', 'agent_plan_set', 'agent_hypothesis_open', 'agent_intent_acquire',
  'agent_intent_release', 'agent_read', 'agent_write', 'agent_exec', 'agent_snapshot_create',
  'agent_snapshot_compare', 'agent_snapshot_rollback', 'agent_hypothesis_judge', 'agent_skill_search',
  'agent_skill_inspect', 'agent_skill_propose', 'agent_run_control',
  'subagent_spawn', 'subagent_status', 'subagent_result', 'subagent_control',
  'android_status', 'android_devices', 'android_device_info', 'android_capture', 'android_ui',
  'android_logcat', 'android_packages', 'android_file_read', 'android_action', 'android_app',
  'android_install', 'android_push', 'android_adb',
  'restore_status','checkpoint_list','checkpoint_inspect','checkpoint_create','recovery_session_list','recovery_session_inspect','recovery_session_begin','recovery_session_end','restore_preview','restore_apply',
];

const call = (def: AnyToolDef, args: Record<string, unknown>) => {
  const parsed = z.object(toolInputShape(def) as z.ZodRawShape).strict().parse(args);
  // discover's handler is pure over the static index; ctx is unused by design.
  return def.handler(parsed as never, {} as ToolCtx);
};
const discover = COMPACT_CATALOG.find((d) => d.name === 'dodo_discover') as AnyToolDef;
const WS = { workspaceId: 'ws_test', workspaceEpoch: 'boot_test' };

describe('compact surface catalog', () => {
  it('full catalog includes the Phase 09 agent family in exact order, with no gateways mixed in', () => {
    expect(TOOL_CATALOG.map((d) => d.name)).toEqual(FULL_NAMES);
    expect(surfaceCatalog('full')).toBe(TOOL_CATALOG);
    expect(TOOL_CATALOG.some((d) => d.name.startsWith('dodo_'))).toBe(false);
  });

  it('compact catalog is at most 20 tools and starts with project_overview + dodo_discover', () => {
    expect(COMPACT_CATALOG.length).toBeLessThanOrEqual(20);
    expect(COMPACT_CATALOG.map((d) => d.name).slice(0, 2)).toEqual(['project_overview', 'dodo_discover']);
    const names = new Set(COMPACT_CATALOG.map((d) => d.name));
    expect(names.size).toBe(COMPACT_CATALOG.length);
  });

  it('every full-catalog capability is reachable through exactly one gateway (project_overview excepted)', () => {
    const seen = new Map<string, string>();
    for (const g of GATEWAY_OPERATIONS) {
      for (const op of g.operations) {
        expect(seen.has(op), `${op} exposed twice`).toBe(false);
        seen.set(op, g.name);
      }
    }
    for (const def of TOOL_CATALOG) {
      if (def.name === 'project_overview') continue;
      expect(seen.get(def.name), `${def.name} unreachable`).toBeDefined();
    }
    expect(seen.size).toBe(TOOL_CATALOG.length - 1);
    expect(Object.fromEntries(OPERATION_TO_GATEWAY)).toEqual(Object.fromEntries(seen));
  });

  it('no gateway can target another gateway, project_overview, or anything outside the catalog', () => {
    const fullNames = new Set(TOOL_CATALOG.map((d) => d.name));
    for (const g of GATEWAY_OPERATIONS) {
      for (const op of g.operations) {
        expect(op.startsWith('dodo_')).toBe(false);
        expect(op).not.toBe('project_overview');
        expect(fullNames.has(op)).toBe(true);
      }
    }
  });

  it('each gateway requires exactly the minimum scope of its targets (target stays the authority)', () => {
    const rank: Record<string, number> = { 'dodo:read': 0, 'dodo:write': 1, 'dodo:exec': 2 };
    const byName = new Map(TOOL_CATALOG.map((d) => [d.name, d]));
    for (const g of GATEWAY_OPERATIONS) {
      const gw = COMPACT_CATALOG.find((d) => d.name === g.name) as AnyToolDef;
      const min = Math.min(...g.operations.map((op) => rank[(byName.get(op) as AnyToolDef).requiredScope] as number));
      expect(rank[gw.requiredScope], g.name).toBe(min);
    }
  });

  it('gateway top-level input schemas are strict (additionalProperties: false) with enum-bound operations', () => {
    for (const g of GATEWAY_OPERATIONS) {
      const gw = COMPACT_CATALOG.find((d) => d.name === g.name) as AnyToolDef;
      const schema = operationSchema(gw).inputSchema as { additionalProperties?: boolean; properties: Record<string, { enum?: string[] }> };
      expect(schema.additionalProperties, g.name).toBe(false);
      expect(schema.properties['operation']?.enum).toEqual([...g.operations]);
      // targetProject (name) routes exactly like targetProjectId (id); both are
      // top-level only and both are rejected inside nested args.
      expect(Object.keys(schema.properties).sort()).toEqual(['args', 'operation', 'recoverySessionId', 'targetProject', 'targetProjectId', 'workspaceEpoch', 'workspaceId']);
    }
  });

  it('read-only annotation is true only for gateways whose every target is read-only', () => {
    const byName = new Map(TOOL_CATALOG.map((d) => [d.name, d]));
    for (const g of GATEWAY_OPERATIONS) {
      const gw = COMPACT_CATALOG.find((d) => d.name === g.name) as AnyToolDef;
      const allRead = g.operations.every((op) => (byName.get(op) as AnyToolDef).annotations.readOnlyHint === true);
      expect(gw.annotations.readOnlyHint, g.name).toBe(allRead);
    }
  });

  it('hybrid surface: exactly 49 tools, coverage core FIRST, then 29 direct tools with unchanged contracts', () => {
    expect(HYBRID_CATALOG.length).toBe(49);
    expect(HYBRID_CATALOG.length).toBeLessThanOrEqual(49);
    // coverage core first: any client-side truncation can only drop direct duplicates
    expect(HYBRID_CATALOG.slice(0, COMPACT_CATALOG.length).map((d) => d.name)).toEqual(COMPACT_CATALOG.map((d) => d.name));
    const direct = HYBRID_CATALOG.slice(COMPACT_CATALOG.length);
    expect(direct.map((d) => d.name)).toEqual([...HYBRID_DIRECT_OPERATIONS]);
    const byName = new Map(TOOL_CATALOG.map((d) => [d.name, d]));
    for (const d of direct) expect(d, d.name).toBe(byName.get(d.name)); // the SAME def objects — contract identical
    for (const op of HYBRID_DIRECT_OPERATIONS) expect(OPERATION_TO_GATEWAY.has(op), op).toBe(true); // still gateway-covered
    const names = new Set(HYBRID_CATALOG.map((d) => d.name));
    expect(names.size).toBe(HYBRID_CATALOG.length);
    expect(surfaceCatalog('hybrid')).toBe(HYBRID_CATALOG);
    const stats = surfaceStats('hybrid');
    expect(stats.toolCount).toBe(49);
    expect(stats.schemaBytes).toBeLessThan(surfaceStats('full').schemaBytes * 0.55);
  });

  it('surface stats: compact serializes to a fraction of the full catalog', () => {
    const compact = surfaceStats('compact');
    const full = surfaceStats('full');
    expect(compact.toolCount).toBe(COMPACT_CATALOG.length);
    expect(full.toolCount).toBe(TOOL_CATALOG.length);
    expect(compact.schemaBytes).toBeLessThan(full.schemaBytes * 0.5);
    expect(surfaceStats('compact')).toEqual(compact); // cached & deterministic
  });

  it('can hide the complete sub-agent feature from live MCP surfaces without changing the static capability catalog', async () => {
    const hidden = { subagents: false } as const;
    const subagents = ['subagent_spawn', 'subagent_status', 'subagent_result', 'subagent_control'];
    const full = surfaceCatalog('full', hidden);
    const compact = surfaceCatalog('compact', hidden);
    const hybrid = surfaceCatalog('hybrid', hidden);

    expect(TOOL_CATALOG).toHaveLength(148); // the installed capability contract stays complete
    expect(full).toHaveLength(144);
    expect(compact).toHaveLength(20);
    expect(hybrid).toHaveLength(49);
    for (const name of subagents) expect(full.some((d) => d.name === name), name).toBe(false);

    for (const gatewayName of ['dodo_assist_read', 'dodo_assist_change']) {
      const gateway = compact.find((d) => d.name === gatewayName) as AnyToolDef;
      const schema = operationSchema(gateway).inputSchema as { properties: { operation: { enum: string[] } } };
      for (const name of subagents) expect(schema.properties.operation.enum, `${gatewayName}:${name}`).not.toContain(name);
    }

    const hiddenDiscover = compact.find((d) => d.name === 'dodo_discover') as AnyToolDef;
    await expect(call(hiddenDiscover, { ...WS, operation: 'subagent_spawn' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const search = await call(hiddenDiscover, { ...WS, query: 'subagent', limit: 25 });
    expect((search.data as { matches: Array<{ operation: string }> }).matches).toEqual([]);

    expect(surfaceStats('full', hidden).toolCount).toBe(144);
    expect(surfaceStats('compact', hidden).toolCount).toBe(20);
    expect(surfaceStats('hybrid', hidden).toolCount).toBe(49);
    expect(surfaceStats('full', { subagents: true }).toolCount).toBe(148);
    expect(instructionsFor('compact', hidden)).not.toContain('subagent_spawn');
    expect(instructionsFor('compact', hidden)).toContain('not exposed');
    expect(instructionsFor('compact', { subagents: true })).toContain('subagent_spawn');
  });
});

describe('dodo_discover', () => {
  it('query search returns gateway-routed matches without any input schemas', async () => {
    const res = await call(discover, { ...WS, query: 'edit a TypeScript file' });
    const data = res.data as { matches: Array<Record<string, unknown>>; totalMatches: number };
    expect(data.matches.length).toBeGreaterThan(0);
    const first = data.matches.map((m) => m['operation']);
    expect(first).toContain('edit_file');
    for (const m of data.matches) {
      expect(m['gateway']).toBe(OPERATION_TO_GATEWAY.get(m['operation'] as string));
      expect(m['inputSchema']).toBeUndefined();
    }
  });

  it('domain filter restricts matches and empty query lists everything paged', async () => {
    const media = await call(discover, { ...WS, domain: 'media', limit: 25 });
    const ops = (media.data as { matches: Array<{ operation: string; gateway: string }> }).matches;
    expect(ops.length).toBe(18);
    expect(ops.every((m) => m.gateway === 'dodo_media')).toBe(true);

    const page1 = await call(discover, { ...WS, limit: 10 });
    expect((page1.data as { matches: unknown[] }).matches).toHaveLength(10);
    expect(page1.nextCursor).toBe('c10');
    const page2 = await call(discover, { ...WS, limit: 10, cursor: 'c10' });
    const total = (page2.data as { totalMatches: number }).totalMatches;
    expect(total).toBe(TOOL_CATALOG.length - 1);
    // deterministic: same call, same pages
    const again = await call(discover, { ...WS, limit: 10 });
    expect(again.data).toEqual(page1.data);
  });

  it('operation detail returns the args-payload schema (no workspace fields) with a deterministic hash and usage notes', async () => {
    const res = await call(discover, { ...WS, operation: 'write_file' });
    const data = res.data as { gateway: string; requiredScope: string; action: string; inputSchema: { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }; schemaHash: string; notes: string[] };
    expect(data.gateway).toBe('dodo_write');
    expect(data.requiredScope).toBe('dodo:write');
    expect(data.action).toBe('mutate-files');
    // args schema = the tool's own fields; workspace context travels at the gateway top level
    expect(Object.keys(data.inputSchema.properties)).toEqual(expect.arrayContaining(['path', 'content', 'expectedHash']));
    expect(data.inputSchema.properties['workspaceId']).toBeUndefined();
    expect(data.inputSchema.properties['workspaceEpoch']).toBeUndefined();
    expect(data.inputSchema.additionalProperties).toBe(false);
    expect(data.notes[0]).toContain('TOP LEVEL');
    expect(data.notes.join(' ')).toContain('expectedHash');
    const again = await call(discover, { ...WS, operation: 'write_file' });
    expect((again.data as { schemaHash: string }).schemaHash).toBe(data.schemaHash);
    expect(data.schemaHash).toBe(operationArgsSchema(TOOL_CATALOG.find((d) => d.name === 'write_file') as AnyToolDef).schemaHash);
    // the full registered schema (used by tools.json/stats) still includes the workspace fields
    const full = operationSchema(TOOL_CATALOG.find((d) => d.name === 'write_file') as AnyToolDef).inputSchema as { properties: Record<string, unknown> };
    expect(full.properties['workspaceId']).toBeDefined();
  });

  it('publishes federation fields through the existing read operations while preserving compact/hybrid budgets', async () => {
    const read = await call(discover, { ...WS, operation: 'read_files' });
    const search = await call(discover, { ...WS, operation: 'search_code' });
    const readSchema = (read.data as { inputSchema: { properties: Record<string, unknown> } }).inputSchema;
    const searchSchema = (search.data as { inputSchema: { properties: Record<string, unknown> } }).inputSchema;
    expect(readSchema.properties['projectId']).toBeDefined();
    expect(searchSchema.properties['projectId']).toBeDefined();
    expect(searchSchema.properties['projectIds']).toBeDefined();
    expect(TOOL_CATALOG).toHaveLength(148);
    expect(COMPACT_CATALOG).toHaveLength(20);
    expect(HYBRID_CATALOG).toHaveLength(49);
  });

  it('idempotency-capable operations carry the retry note; unknown operations are NOT_FOUND', async () => {
    const res = await call(discover, { ...WS, operation: 'run_command' });
    expect((res.data as { notes: string[] }).notes.join(' ')).toContain('idempotencyKey');
    await expect(call(discover, { ...WS, operation: 'project_overview' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(discover, { ...WS, operation: 'dodo_write' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(discover, { ...WS, cursor: 'evil' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
