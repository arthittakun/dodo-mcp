import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Repo-safe `.dodo.json` schema (spec §5). Hints only. It cannot widen
 * permissions: no auth keys, no root, no security settings — `strict()`
 * rejects unknown keys so a malicious repo config fails closed (CFG-01) and
 * is reported as invalid instead of being merged.
 */
export const ProjectTaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,63}$/),
    title: z.string().min(1).max(120),
    program: z.string().min(1).max(256),
    args: z.array(z.string().max(1024)).max(64).default([]),
    /** Workspace-relative cwd; validated through path policy before any use. */
    cwd: z.string().max(1024).optional(),
  })
  .strict();

export const ProjectConfigSchema = z
  .object({
    /** Human hints only. */
    name: z.string().min(1).max(120).optional(),
    description: z.string().min(1).max(2000).optional(),
    /** Narrowing globs (gitignore syntax). Can only EXCLUDE more, never re-include denied paths. */
    exclude: z.array(z.string().min(1).max(256)).max(200).default([]),
    /** Task recipes are data; running one always requires the local approval flow. */
    tasks: z.array(ProjectTaskSchema).max(50).default([]),
  })
  .strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface ProjectConfigResult {
  config: ProjectConfig;
  /** Present when a .dodo.json existed but was rejected; the file is then ignored entirely. */
  invalidReason?: string;
  present: boolean;
}

export const EMPTY_PROJECT_CONFIG: ProjectConfig = ProjectConfigSchema.parse({});

const MAX_PROJECT_CONFIG_BYTES = 64 * 1024;

export function loadProjectConfig(root: string): ProjectConfigResult {
  const file = path.join(root, '.dodo.json');
  let raw: Buffer;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_PROJECT_CONFIG_BYTES) {
      return { config: EMPTY_PROJECT_CONFIG, present: true, invalidReason: 'not a regular file or too large' };
    }
    raw = fs.readFileSync(file);
  } catch {
    return { config: EMPTY_PROJECT_CONFIG, present: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { config: EMPTY_PROJECT_CONFIG, present: true, invalidReason: 'invalid JSON' };
  }
  const result = ProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    const reason = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { config: EMPTY_PROJECT_CONFIG, present: true, invalidReason: reason };
  }
  return { config: result.data, present: true };
}
