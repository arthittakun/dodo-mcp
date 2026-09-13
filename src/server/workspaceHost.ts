import fs from 'node:fs';
import path from 'node:path';
import type { BootstrappedWorkspace } from './bootstrap.js';
import { resolveWorkspaceRoot } from '../workspace/root.js';
import { mintWorkspaceId } from '../workspace/identity.js';
import { DodoError } from '../errors.js';

/**
 * Owns the ACTIVE workspace of a long-running `dodo start` process and
 * performs the owner-triggered runtime switch to another root.
 *
 * Contract (ADR-019):
 * - exactly one active workspace at any moment; readers call `current()` per
 *   request instead of capturing a workspace in a closure;
 * - a switch is refused while jobs run or while MCP requests are in flight
 *   (after a bounded drain), never killing anything silently;
 * - the new workspace is bootstrapped, checked for readiness and given its
 *   per-workspace resources (IPC socket) BEFORE the swap; any failure leaves
 *   the old workspace untouched and serving;
 * - the old workspace is shut down only AFTER the swap, so no request ever
 *   sees a half-closed service;
 * - identity (workspaceId) and epoch come from the new bootstrap, so context
 *   captured from the old workspace fails WORKSPACE_MISMATCH / STALE_WORKSPACE
 *   by the existing per-call checks; trust mode and client ACLs are the NEW
 *   root's own rows, nothing is copied.
 */
export interface WorkspaceResources {
  close(): Promise<void>;
}

export interface WorkspaceHostOptions {
  initial: BootstrappedWorkspace;
  initialResources?: WorkspaceResources;
  /** Build a fresh workspace for an already validated root (same config dir and run mode). */
  bootstrap: (root: string) => BootstrappedWorkspace;
  /** Per-workspace resources (IPC socket, …) started BEFORE the swap; a throw aborts the switch. */
  resources?: (ws: BootstrappedWorkspace) => Promise<WorkspaceResources>;
  /** True when another live process already serves the target root (its IPC socket answers). */
  isRootServedElsewhere?: (workspaceId: string) => Promise<boolean>;
  log: (line: string) => void;
  /** How long to wait for in-flight MCP requests before refusing the switch. */
  drainTimeoutMs?: number;
}

export interface SwitchInput {
  path: string;
  /** Test hook: override the drain wait for this call. */
  drainTimeoutMs?: number;
}

export interface SwitchResult {
  changed: boolean;
  root: string;
  workspaceId: string;
  epoch: string;
  previousRoot: string;
  trustMode: string;
}

export type HostState = 'ready' | 'switching' | 'closed';

export interface WorkspaceHost {
  current(): BootstrappedWorkspace;
  state(): HostState;
  /** MCP request tracking so a switch can drain instead of racing. */
  inflight: { enter(): () => void; count(): number };
  switchTo(input: SwitchInput): Promise<SwitchResult>;
  onSwitch(listener: (next: BootstrappedWorkspace, prev: BootstrappedWorkspace) => void): () => void;
  close(): Promise<void>;
}

const MAX_PATH_INPUT = 4096;

export function createWorkspaceHost(opts: WorkspaceHostOptions): WorkspaceHost {
  let current = opts.initial;
  let currentResources = opts.initialResources;
  let state: HostState = 'ready';
  let inflightCount = 0;
  const listeners = new Set<(next: BootstrappedWorkspace, prev: BootstrappedWorkspace) => void>();
  const drainDefault = opts.drainTimeoutMs ?? 15_000;

  const inflight = {
    enter(): () => void {
      inflightCount += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        inflightCount -= 1;
      };
    },
    count: () => inflightCount,
  };

  async function switchTo(input: SwitchInput): Promise<SwitchResult> {
    if (state === 'closed') throw new DodoError('CONFLICT', 'server is shutting down');
    if (state === 'switching') throw new DodoError('CONFLICT', 'a workspace switch is already in progress');
    const target = validateTarget(input.path);
    if (target.root === current.rootInfo.root) {
      return { changed: false, root: current.rootInfo.root, workspaceId: current.workspaceId, epoch: current.epoch, previousRoot: current.rootInfo.root, trustMode: current.services.trustMode() };
    }
    const running = current.services.jobs.runningCount();
    if (running > 0) {
      throw new DodoError('CONFLICT', `${running} job(s) are still running in the current workspace`, {
        recovery: 'wait for them to finish or cancel them (job_cancel / dodo stop) before switching; DODO never kills jobs silently',
      });
    }

    state = 'switching';
    const prev = current;
    const prevResources = currentResources;
    let next: BootstrappedWorkspace | undefined;
    let nextResources: WorkspaceResources | undefined;
    try {
      // 1. Drain: refuse rather than yank services from under a live request.
      const deadline = Date.now() + (input.drainTimeoutMs ?? drainDefault);
      while (inflightCount > 0 && Date.now() < deadline) await sleep(50);
      if (inflightCount > 0) {
        throw new DodoError('CONFLICT', `${inflightCount} MCP request(s) still in flight`, { recovery: 'retry in a moment' });
      }
      // A request that was in flight may have started a job: check again now
      // that nothing new can arrive (the gate returns 503 while switching).
      const startedMeanwhile = prev.services.jobs.runningCount();
      if (startedMeanwhile > 0) {
        throw new DodoError('CONFLICT', `${startedMeanwhile} job(s) started while preparing the switch`, {
          recovery: 'wait for them to finish or cancel them, then retry',
        });
      }
      // 2. Another live process for that root would be clobbered by our IPC bind.
      const nextId = mintWorkspaceId(prev.store.installSecret(), target.root);
      if (opts.isRootServedElsewhere && (await opts.isRootServedElsewhere(nextId))) {
        throw new DodoError('CONFLICT', 'another DODO process already serves that directory', {
          recovery: 'stop it there (dodo stop) or use that process instead',
        });
      }
      // 3. Bootstrap + readiness, before anything old is touched.
      next = opts.bootstrap(target.root);
      assertReady(next);
      // 4. Per-workspace resources for the NEW root (IPC socket) — may fail, e.g. EADDRINUSE.
      nextResources = opts.resources ? await opts.resources(next) : undefined;
      // 5. Commit: from here on every reader sees the new workspace.
      current = next;
      currentResources = nextResources;
    } catch (err) {
      // Rollback: the old workspace was never touched; discard the half-built one.
      state = 'ready';
      if (nextResources) await nextResources.close().catch(() => undefined);
      if (next) await next.shutdownServices().catch(() => undefined);
      throw err;
    }

    // 6. Old workspace teardown, strictly after the swap (best effort, logged).
    try {
      await prevResources?.close();
    } catch (err) {
      opts.log(`[dodo] workspace switch: old IPC close failed: ${(err as Error).message}`);
    }
    try {
      await prev.shutdownServices();
    } catch (err) {
      opts.log(`[dodo] workspace switch: old services shutdown failed: ${(err as Error).message}`);
    }
    // Pending approvals of the old workspace/epoch can never be completed
    // now; deny them explicitly instead of leaving them to expire silently.
    try {
      for (const approval of current.store.listPendingApprovals()) {
        if (approval.workspaceId === prev.workspaceId && approval.epoch === prev.epoch) current.store.setApprovalStatus(approval.id, 'denied');
      }
    } catch {
      /* best effort */
    }
    try {
      current.store.audit({
        principal: 'local-config-owner',
        workspaceId: current.workspaceId,
        tool: 'local.workspace.switch',
        paths: [prev.rootInfo.root, current.rootInfo.root],
        refId: prev.workspaceId,
        result: 'switched',
      });
    } catch {
      /* audit is best effort */
    }
    opts.log(`[dodo] workspace switched: ${prev.rootInfo.root} → ${current.rootInfo.root} (${current.workspaceId}, epoch ${current.epoch})`);
    for (const l of listeners) {
      try {
        l(current, prev);
      } catch {
        /* listener errors never break the switch */
      }
    }
    state = 'ready';
    return { changed: true, root: current.rootInfo.root, workspaceId: current.workspaceId, epoch: current.epoch, previousRoot: prev.rootInfo.root, trustMode: current.services.trustMode() };
  }

  return {
    current: () => current,
    state: () => state,
    inflight,
    switchTo,
    onSwitch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (state === 'closed') return;
      // Let an in-progress switch settle instead of closing under it.
      while (state === 'switching') await sleep(50);
      state = 'closed';
      while (inflightCount > 0) await sleep(25);
      try {
        await currentResources?.close();
      } catch {
        /* best effort */
      }
      await current.shutdownServices();
    },
  };
}

/** Owner input → validated real root, through the shared root policy (no --allow-unsafe-root over HTTP). */
export function validateTarget(input: unknown): { root: string } {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_PATH_INPUT || input.includes('\0')) {
    throw new DodoError('INVALID_INPUT', 'path must be a non-empty absolute path');
  }
  if (!path.isAbsolute(input)) {
    throw new DodoError('INVALID_INPUT', 'path must be absolute (e.g. /Users/you/projects/app)');
  }
  const info = resolveWorkspaceRoot(input, { allowUnsafe: false });
  return { root: info.root };
}

function assertReady(ws: BootstrappedWorkspace): void {
  try {
    if (!fs.statSync(ws.rootInfo.root).isDirectory()) throw new Error('root is not a directory');
    ws.store.trustMode(ws.workspaceId); // store reachable for this workspace
    ws.services.listService.tree('.', { depth: 1, maxEntries: 5 }); // path policy + filesystem answer
  } catch (err) {
    throw new DodoError('INTERNAL_ERROR', `new workspace failed its readiness check: ${(err as Error).message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
