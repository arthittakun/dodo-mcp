import fs from 'node:fs';
import type { Command } from 'commander';
import { DodoError } from '../errors.js';

/** Private owner IPC only; reviewed files are bounded JSON, never executable repository configuration. */
export function registerDeploymentCommands(program: Command, ipc: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): void {
  const group = program.command('deployment').description('review registered Docker deployment targets and durable build/deploy outcomes');
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  for (const op of ['targets', 'list'] as const) group.command(op).action(async () => print(await ipc(`deployment.${op}`)));
  for (const op of ['inspect', 'compare'] as const) group.command(`${op} <deploymentId>`).action(async (deploymentId: string) => print(await ipc(`deployment.${op}`, { deploymentId })));
  const reviewed = (cmd: Command) => cmd.requiredOption('--workspace <id>', 'reviewed workspace ID')
    .requiredOption('--epoch <epoch>', 'reviewed workspace epoch').option('--yes', 'confirm the exact reviewed operation', false);
  type Review = { workspace: string; epoch: string; yes: boolean };
  const envelope = (opts: Review, input: unknown) => {
    if (!opts.yes) throw new DodoError('INVALID_INPUT', 'review target/source and add --yes; Docker commands may affect resources outside the workspace');
    return { workspaceId: opts.workspace, workspaceEpoch: opts.epoch, confirm: true, input };
  };
  reviewed(group.command('configure').requiredOption('--file <path>', 'owner-reviewed target JSON: expectedRevision, enabled, definition, confirmDaemonAccess'))
    .action(async (opts: Review & { file: string }) => {
      const st = fs.lstatSync(opts.file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 128 * 1024) throw new DodoError('INVALID_INPUT', 'target configuration must be a regular JSON file at most 128 KiB');
      let input: unknown; try { input = JSON.parse(fs.readFileSync(opts.file, 'utf8')); } catch { throw new DodoError('INVALID_INPUT', 'invalid target JSON'); }
      print(await ipc('deployment.configure', envelope(opts, input)));
    });
  reviewed(group.command('prepare').requiredOption('--target <id>', 'owner-registered target ID').requiredOption('--revision <n>', 'target revision')
    .requiredOption('--verification <id>', 'current VERIFIED verification ID').requiredOption('--key <key>', 'idempotency key; reuse for retries'))
    .action(async (opts: Review & { target: string; revision: string; verification: string; key: string }) => print(await ipc('deployment.prepare', envelope(opts, {
      targetId: opts.target, expectedTargetRevision: Number(opts.revision), verificationId: opts.verification, idempotencyKey: opts.key,
    }))));
  reviewed(group.command('build <deploymentId>').requiredOption('--hash <hash>', 'reviewed plan hash'))
    .action(async (deploymentId: string, opts: Review & { hash: string }) => print(await ipc('deployment.build', envelope(opts, { deploymentId, planHash: opts.hash }))));
  reviewed(group.command('apply <deploymentId>').requiredOption('--hash <hash>', 'reviewed plan hash').requiredOption('--image <digest>', 'reviewed immutable image digest'))
    .action(async (deploymentId: string, opts: Review & { hash: string; image: string }) => print(await ipc('deployment.apply', envelope(opts, { deploymentId, planHash: opts.hash, imageDigest: opts.image }))));
  for (const op of ['observe', 'source-preview'] as const) reviewed(group.command(`${op} <deploymentId>`))
    .action(async (deploymentId: string, opts: Review) => print(await ipc('deployment.'+op.replaceAll('-','_'), envelope(opts, { deploymentId }))));
  reviewed(group.command('maintenance').requiredOption('--file <path>', 'owner-reviewed maintenance JSON; preview returns a review ID/hash for apply'))
    .action(async (opts: Review & {file:string}) => {
      const st=fs.lstatSync(opts.file);
      if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>65536)throw new DodoError('INVALID_INPUT','maintenance JSON must be a bounded regular file');
      let input:unknown;try{input=JSON.parse(fs.readFileSync(opts.file,'utf8'));}catch{throw new DodoError('INVALID_INPUT','invalid maintenance JSON');}
      print(await ipc('deployment.maintenance',envelope(opts,input)));
    });
  reviewed(group.command('rollback-prepare <deploymentId>').requiredOption('--key <key>', 'idempotency key for this rollback review'))
    .action(async (deploymentId: string, opts: Review & { key: string }) => print(await ipc('deployment.rollback_prepare', envelope(opts, { deploymentId, idempotencyKey: opts.key }))));
}
