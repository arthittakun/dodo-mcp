import fs from 'node:fs';
import type { Command } from 'commander';
import { DodoError } from '../errors.js';

export function registerDataRecoveryCommands(recovery: Command, ipc: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  const database = recovery.command('database').description('owner-only read-only migration compatibility; never database rollback');
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  database.command('targets').action(async () => print(await ipc('recovery.database.list')));
  type Review = { workspace: string; epoch: string; yes: boolean };
  const review = (cmd: Command) => cmd.requiredOption('--workspace <id>', 'current workspace ID').requiredOption('--epoch <epoch>', 'current epoch').option('--yes', 'confirm the exact owner operation', false);
  const envelope = (opts: Review, input: unknown) => {
    if (!opts.yes) throw new DodoError('INVALID_INPUT', 'review the owner operation and add --yes');
    return { workspaceId: opts.workspace, workspaceEpoch: opts.epoch, confirm: true, input };
  };
  review(database.command('inspect <targetId>')).action(async (targetId: string, opts: Review) => print(await ipc('recovery.database.inspect', envelope(opts, { targetId }))));
  const jsonOperation = (group: Command, operation: string, method: string) => review(group.command(operation).requiredOption('--file <path>', 'owner-reviewed bounded JSON; never secret values'))
    .action(async (opts: Review & { file: string }) => {
      const st = fs.lstatSync(opts.file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 128 * 1024) throw new DodoError('INVALID_INPUT', 'expected a bounded regular JSON file');
      let input: unknown; try { input = JSON.parse(fs.readFileSync(opts.file, 'utf8')); } catch { throw new DodoError('INVALID_INPUT', 'invalid owner JSON'); }
      print(await ipc(method, envelope(opts, input)));
    });
  for (const op of ['configure', 'bind', 'unbind']) jsonOperation(database, op, 'recovery.database.' + op);
  const vault = recovery.command('private-config').description('owner-only encrypted secret-file recovery; explicit opt-in and OS key store required');
  vault.command('list').action(async () => print(await ipc('recovery.config.list')));
  jsonOperation(vault, 'configure', 'recovery.config.configure');
  review(vault.command('backup <targetId>')).action(async (targetId: string, opts: Review) => print(await ipc('recovery.config.backup', envelope(opts, { targetId }))));
  review(vault.command('preview <backupId>')).action(async (backupId: string, opts: Review) => print(await ipc('recovery.config.preview', envelope(opts, { backupId }))));
  review(vault.command('apply <planId>').requiredOption('--hash <hash>', 'exact reviewed plan hash')).action(async (planId: string, opts: Review & { hash: string }) => print(await ipc('recovery.config.apply', envelope(opts, { planId, planHash: opts.hash }))));
  review(vault.command('rotate <targetId>').requiredOption('--revision <n>', 'current target revision', Number)).action(async (targetId: string, opts: Review & { revision: number }) => print(await ipc('recovery.config.rotate', envelope(opts, { targetId, expectedRevision: opts.revision }))));
}
