import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';

/**
 * Regex search worker (JS fallback when ripgrep is absent). Runs in a worker
 * thread so a catastrophic-backtracking pattern can be TERMINATED by the host
 * on timeout instead of stalling the event loop. It only reads the absolute
 * paths the host already validated through WorkspaceFS.
 */
interface WorkerInput {
  files: Array<{ rel: string; abs: string }>;
  pattern: string;
  flags: string;
  skip: number;
  maxResults: number;
  contextBefore: number;
  contextAfter: number;
  maxFileBytes: number;
  maxLineChars: number;
}

interface WorkerMatch {
  path: string;
  line: number;
  column: number;
  lineText: string;
  before: string[];
  after: string[];
}

const input = workerData as WorkerInput;

function run(): { matches: WorkerMatch[]; filesScanned: number; truncated: boolean } | { error: string } {
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, input.flags.includes('g') ? input.flags : `${input.flags}g`);
  } catch {
    return { error: 'invalid regex pattern' };
  }
  const matches: WorkerMatch[] = [];
  let index = 0;
  let filesScanned = 0;
  let truncated = false;
  const cut = (s: string) => (s.length > input.maxLineChars ? s.slice(0, input.maxLineChars) : s);
  outer: for (const f of input.files) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(f.abs);
    } catch {
      continue;
    }
    filesScanned += 1;
    if (buf.length > input.maxFileBytes || buf.subarray(0, 8192).includes(0)) continue;
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (let ln = 0; ln < lines.length; ln += 1) {
      const line = lines[ln] as string;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        index += 1;
        if (index > input.skip) {
          if (matches.length >= input.maxResults) {
            truncated = true;
            break outer;
          }
          matches.push({
            path: f.rel,
            line: ln + 1,
            column: m.index + 1,
            lineText: cut(line),
            before: lines.slice(Math.max(0, ln - input.contextBefore), ln).map(cut),
            after: lines.slice(ln + 1, ln + 1 + input.contextAfter).map(cut),
          });
        }
        if (m[0].length === 0) re.lastIndex += 1; // avoid zero-width infinite loops
      }
    }
  }
  return { matches, filesScanned, truncated };
}

parentPort?.postMessage(run());
