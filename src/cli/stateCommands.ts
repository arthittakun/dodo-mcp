import type { Command } from 'commander';
import { resolveConfigDir } from '../config/paths.js';
import { createStateCheckpoint, inspectStateCheckpoint, listStateCheckpoints, restoreStateCheckpoint } from '../config/stateCheckpoint.js';
import { DodoError } from '../errors.js';

/** Local owner commands only; no MCP route can restore installation credentials or authorization. */
export function registerStateCommands(program: Command): void {
  const state = program.command('state').description('inspect private installation checkpoints and restore compatible DB/config/Env state offline');
  const directory = () => resolveConfigDir(process.env).dir;
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  state.command('list').description('list verified checkpoints; never prints credential values').action(() => print({ checkpoints: listStateCheckpoints(directory()) }));
  state.command('inspect <checkpointId>').description('verify hashes/schema and obtain the manifest hash for an exact restore').action((id: string) => print(inspectStateCheckpoint(directory(), id)));
  state.command('create').description('create a private WAL-correct installation checkpoint with other DODO processes stopped').action(() => print(createStateCheckpoint(directory())));
  state.command('restore <checkpointId>')
    .description('offline restore; reverts authentication/settings to the checkpoint and saves the current state first')
    .requiredOption('--hash <sha256>', 'manifestHash from dodo state inspect')
    .option('--yes', 'confirm restoring DB/config/owned Env/keys and revoking restored login; later changes remain only in emergency checkpoint', false)
    .action((id: string, options: { hash: string; yes: boolean }) => {
      if (!options.yes) throw new DodoError('INVALID_INPUT', 'inspect this checkpoint and add --yes to confirm the exact offline restore');
      print(restoreStateCheckpoint(directory(), id, { confirm: true, expectedManifestHash: options.hash }));
    });
}
