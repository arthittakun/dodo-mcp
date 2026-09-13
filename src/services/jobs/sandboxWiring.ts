import os from 'node:os';
import path from 'node:path';
import type { GlobalConfig } from '../../config/globalConfig.js';
import { DodoError } from '../../errors.js';
import { sandboxAvailability, wrapInSandbox } from './sandbox.js';

/**
 * Bridges the global `commandSandbox` policy to the OS sandbox adapter
 * (./sandbox.ts: macOS seatbelt / Linux bwrap). This module decides WHEN the
 * sandbox applies and what stays writable; JobManager just calls the wrapper.
 */
export interface SandboxSpawn {
  program: string;
  args: string[];
  kind: string;
  windowsVerbatimArguments?: boolean;
}

export type SandboxWrapper = (
  program: string,
  args: string[],
  opts: { allowNetwork: boolean; requested: boolean | undefined; windowsVerbatimArguments?: boolean; privateScript?: string; readablePaths?: string[]; writablePaths?: string[] },
) => SandboxSpawn | undefined;

export function sandboxWrapperFromConfig(config: GlobalConfig, workspaceRoot: string, ownerStateDir?: string): SandboxWrapper {
  const mode = config.commandSandbox;
  const home = os.homedir();
  // Caches most toolchains need even for "workspace-only" writes.
  // macOS keeps a per-user cache dir next to the temp dir (…/T → …/C); Python/Xcode tooling writes there.
  const darwinUserCache = path.resolve(os.tmpdir(), '..', 'C');
  const defaultWritable = [`${home}/.npm`, `${home}/.cache`, `${home}/.yarn`, `${home}/Library/Caches`, `${home}/.cargo/registry`, `${home}/.pnpm-store`, darwinUserCache];
  return (program, args, opts) => {
    const wanted = opts.requested ?? mode !== 'off';
    if (!wanted) return undefined;
    const avail = sandboxAvailability(process.env, ownerStateDir, workspaceRoot);
    if (!avail.available) {
      if (opts.requested === true || mode === 'require') {
        throw new DodoError('NOT_SUPPORTED', `OS sandbox requested but unavailable: ${avail.reason ?? 'unsupported platform'}`, {
          recovery: 'run with sandbox:false, or set commandSandbox to "off"/"prefer" in the global config',
        });
      }
      return undefined; // 'prefer' + unavailable → run unsandboxed (the tool reports sandboxed:false)
    }
    const wrapped = wrapInSandbox(program, args, {
      workspaceRoot,
      writablePaths: [...defaultWritable, ...config.sandboxWritablePaths, ...(opts.writablePaths ?? [])],
      readablePaths: opts.readablePaths ?? [],
      ...(opts.privateScript ? { privateScript: opts.privateScript } : {}),
      allowNetwork: opts.allowNetwork,
      ...(ownerStateDir ? { ownerStateDir } : {}),
      ...(opts.windowsVerbatimArguments !== undefined ? { windowsVerbatimArguments: opts.windowsVerbatimArguments } : {}),
    });
    return { program: wrapped.program, args: wrapped.args, kind: wrapped.kind, ...(wrapped.windowsVerbatimArguments !== undefined ? { windowsVerbatimArguments: wrapped.windowsVerbatimArguments } : {}) };
  };
}
