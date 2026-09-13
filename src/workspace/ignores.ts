import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

/**
 * Exclusion engine (spec §10.2), three independent layers:
 *
 * 1. SECRET DENY — hard denies that nothing bypasses (not `includeIgnored`,
 *    not search, not git output, not semantic tools).
 * 2. PROTECTED — `.git/` internals and DODO dev state; never listed or read
 *    directly (no raw .git tool), not bypassable.
 * 3. ORDINARY — default build/cache excludes, `.gitignore` (root + nested),
 *    `.dodoignore`, and repo-config `exclude` globs. `includeIgnored` bypasses
 *    only this layer.
 */

const DEFAULT_SECRET_PATTERNS = [
  '.env',
  '.env.*',
  '*.env',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '*.kdbx',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.ssh/',
  '.gnupg/',
  '.aws/',
  '.kube/config',
  '.docker/config.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'credentials.json',
  'service-account*.json',
  '*.tfstate',
  '*.tfstate.*',
];

const PROTECTED_PATTERNS = ['.git/', '.dodo-dev-state/'];

const DEFAULT_ORDINARY_PATTERNS = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.cache/',
  '.turbo/',
  'coverage/',
  'target/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.tox/',
  '.DS_Store',
  '*.min.js',
  '*.map',
];

export interface IgnoreEngineOptions {
  root: string;
  extraSecretPatterns?: string[];
  /** Owner-configured exceptions to the secret deny (negations appended after the defaults). */
  secretAllow?: string[];
  projectExcludes?: string[];
}

interface DirRules {
  dirRel: string; // '' for root
  matcher: Ignore;
}

const MAX_IGNORE_FILE_BYTES = 256 * 1024;
const MAX_NESTED_IGNORE_FILES = 200;

export class IgnoreEngine {
  private readonly root: string;
  private readonly secret: Ignore;
  private readonly protected_: Ignore;
  private readonly ordinaryBase: Ignore;
  private readonly nested = new Map<string, DirRules | null>();
  private nestedCount = 0;

  constructor(opts: IgnoreEngineOptions) {
    this.root = opts.root;
    this.secret = ignore().add(DEFAULT_SECRET_PATTERNS);
    if (opts.extraSecretPatterns?.length) this.secret.add(opts.extraSecretPatterns);
    // Explicit owner exceptions only — never derived from repo config.
    if (opts.secretAllow?.length) this.secret.add(opts.secretAllow.map((p) => (p.startsWith('!') ? p : `!${p}`)));
    this.protected_ = ignore().add(PROTECTED_PATTERNS);
    this.ordinaryBase = ignore().add(DEFAULT_ORDINARY_PATTERNS);
    for (const file of ['.gitignore', '.dodoignore']) {
      const content = this.readIgnoreFile(path.join(this.root, file));
      if (content !== undefined) this.ordinaryBase.add(content);
    }
    if (opts.projectExcludes?.length) this.ordinaryBase.add(opts.projectExcludes);
  }

  private readIgnoreFile(absFile: string): string | undefined {
    try {
      const st = fs.lstatSync(absFile);
      if (!st.isFile() || st.size > MAX_IGNORE_FILE_BYTES) return undefined;
      return fs.readFileSync(absFile, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Hard secret deny — includeIgnored can never bypass this. */
  isSecret(rel: string): boolean {
    if (rel === '.' || rel === '') return false;
    return this.secret.ignores(rel) || (isDirLike(rel) && this.secret.ignores(rel + '/'));
  }

  /** Protected internals (.git etc.) — never listed, never read. */
  isProtected(rel: string): boolean {
    if (rel === '.' || rel === '') return false;
    return this.protected_.ignores(rel) || this.protected_.ignores(rel + '/');
  }

  /**
   * Ordinary ignore check. `isDir` improves gitignore directory-pattern
   * fidelity. Nested .gitignore files are honored on the walked path.
   */
  isOrdinarilyIgnored(rel: string, isDir: boolean): boolean {
    const probe = isDir ? rel + '/' : rel;
    if (this.ordinaryBase.ignores(probe)) return true;
    // Nested .gitignore files: check each ancestor directory's rules.
    let dir = path.posix.dirname(rel);
    while (dir !== '.' && dir !== '') {
      const rules = this.nestedRules(dir);
      if (rules) {
        const sub = rel.slice(dir.length + 1);
        if (sub !== '' && rules.matcher.ignores(isDir ? sub + '/' : sub)) return true;
      }
      dir = path.posix.dirname(dir);
    }
    return false;
  }

  private nestedRules(dirRel: string): DirRules | null {
    const cached = this.nested.get(dirRel);
    if (cached !== undefined) return cached;
    if (this.nestedCount >= MAX_NESTED_IGNORE_FILES) return null;
    const content = this.readIgnoreFile(path.join(this.root, dirRel, '.gitignore'));
    let rules: DirRules | null = null;
    if (content !== undefined) {
      rules = { dirRel, matcher: ignore().add(content) };
      this.nestedCount += 1;
    }
    this.nested.set(dirRel, rules);
    return rules;
  }

  /**
   * Combined visibility decision for listings/search/reads.
   * Returns the strongest applicable class.
   */
  classify(rel: string, isDir: boolean, includeIgnored: boolean): 'ok' | 'secret' | 'protected' | 'ignored' {
    if (this.isSecret(rel)) return 'secret';
    if (this.isProtected(rel)) return 'protected';
    if (!includeIgnored && this.isOrdinarilyIgnored(rel, isDir)) return 'ignored';
    return 'ok';
  }
}

function isDirLike(rel: string): boolean {
  return !path.posix.basename(rel).includes('.');
}
