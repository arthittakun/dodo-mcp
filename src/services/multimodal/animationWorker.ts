import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertWindowsArgv } from '../../platform/shell.js';
import { AnimationWorkerSpec, BridgeResult, type AnimationWorkerSpecData } from './animationContracts.js';

/**
 * Runs as an OWNED JobManager subprocess and drives the vendored Gift engine. Python runs in
 * isolated mode (-I: no PYTHON* variables, user site or script-directory imports) without
 * bytecode writes (-B), inside the private job directory. Inputs contain no URLs or
 * client-selected paths; OS-level network denial follows the configured sandbox.
 * JobManager owns the wall timeout and cancels this worker's entire process tree,
 * including Python and FFmpeg; killing only Python would orphan its encoder.
 */
const OUTPUT_CAP = 64 * 1024 * 1024;

function missingModule(stderr: string): string | undefined {
  return /ModuleNotFoundError: No module named '([A-Za-z0-9_.]+)'/.exec(stderr)?.[1];
}

export async function runBridge(spec: AnimationWorkerSpecData, specFile: string): Promise<void> {
  const args = ['-I', '-B', '-X', 'utf8', spec.bridge, specFile];
  if (process.platform === 'win32') assertWindowsArgv(spec.python, args);
  const env: NodeJS.ProcessEnv = { ...process.env, GIFT_CAPTION_ENGINE: 'harfbuzz', ...(spec.ffmpeg ? { GIFT_FFMPEG: spec.ffmpeg } : {}) };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.python, args, { cwd: spec.directory, env, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.on('error', reject);
    child.stderr.on('data', (buffer: Buffer) => { errors = (errors + buffer.toString('utf8')).slice(-6000); });
    child.on('close', code => {
      if (code === 0) return resolve();
      const module = missingModule(errors);
      reject(new Error(module
        ? `the animation Python environment lacks the '${module}' package; run dodo-media-setup --install-animation (or point DODO_ANIMATION_PYTHON at Python 3.11+ with Pillow, pydantic and uharfbuzz)`
        : `animation engine exited ${code}: ${errors.slice(-1500)}`));
    });
  });
}

function checkOutput(directory: string, name: string): void {
  const file = path.join(directory, name), st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size === 0 || st.size > OUTPUT_CAP) throw new Error(`missing, unsafe or oversized animation output: ${name}`);
}

async function main(): Promise<void> {
  const specFile = process.argv[2]; if (!specFile) throw new Error('private spec path required');
  const st = fs.lstatSync(specFile); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 256 * 1024) throw new Error('invalid private spec');
  const spec = AnimationWorkerSpec.parse(JSON.parse(fs.readFileSync(specFile, 'utf8')));
  if (path.dirname(specFile) !== spec.directory) throw new Error('spec directory mismatch');
  await runBridge(spec, specFile);
  checkOutput(spec.directory, 'result.json');
  const result = BridgeResult.parse(JSON.parse(fs.readFileSync(path.join(spec.directory, 'result.json'), 'utf8')));
  if (result.operation !== spec.operation) throw new Error('animation operation mismatch');
  for (const name of [result.animation?.file, result.preview?.file, result.plan?.guide.file, result.plan?.mask.file, ...result.companions.map(c => c.file)]) if (name) checkOutput(spec.directory, name);
  process.stdout.write(JSON.stringify({ operation: result.operation, status: result.error ? 'rejected' : 'completed' }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { process.stderr.write(`Animation rendering failed: ${(err as Error).message}\n`); process.exitCode = 1; });
}
