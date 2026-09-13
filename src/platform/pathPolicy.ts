import path from 'node:path';
import { DodoError } from '../errors.js';

/** Segment-aware containment, including drive/case semantics on Windows. */
export function isWithinPath(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(p.resolve(root), p.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

/** Reject ambiguous Win32/NTFS spellings before a filesystem call. */
export function assertWindowsSegment(segment: string): void {
  if (/[<>:"|?*\u0000-\u001f]/u.test(segment) || /[ .]$/u.test(segment)) {
    throw new DodoError('PATH_DENIED', 'Windows paths cannot contain ADS, control characters, wildcards, or trailing dots/spaces');
  }
  if (/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/iu.test(segment)) {
    throw new DodoError('PATH_DENIED', 'Windows device names are not workspace files');
  }
  // Canonical resolution is still required: not all aliases contain a tilde.
  if (/~[0-9]+(?:\.|$)/u.test(segment)) {
    throw new DodoError('PATH_DENIED', 'Windows short-name aliases are refused; use the original long filename');
  }
}

export function assertLocalWindowsRoot(root: string): void {
  if (!/^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\')) {
    throw new DodoError('PATH_DENIED', 'Windows native workspaces require a local drive path; UNC and device namespaces are not supported');
  }
  for (const segment of root.slice(3).split(/[\\/]/u).filter(Boolean)) assertWindowsSegment(segment);
}
