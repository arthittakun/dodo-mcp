import fs from 'node:fs';
import { z } from 'zod';
import { LimitsSchema, DEFAULT_LIMITS, type Limits } from './limits.js';
import { DodoError } from '../errors.js';
import { RecoveryInstallationSchema } from '../services/recovery/contracts.js';
import { TunnelConfigSchema } from './tunnelConfig.js';

/**
 * Trusted global configuration (spec §5). Lives in the user-owned config dir,
 * file mode 0600. This is the ONLY config source that can grant authority;
 * repo `.dodo.json` never reaches this schema.
 */
export const GlobalConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    recovery: RecoveryInstallationSchema.default(RecoveryInstallationSchema.parse({})),
    /** Public HTTPS origin of the user-managed tunnel, e.g. https://dodo.example.com (no path). */
    publicUrl: z.string().url().optional(),
    port: z.number().int().min(0).max(65535).default(21730),
    configPort: z.number().int().min(0).max(65535).default(21731),
    /** Extra allowed Host header hostnames beyond publicUrl host + loopback. */
    allowedHosts: z.array(z.string().min(1).max(255)).max(20).default([]),
    /** Allowed browser Origin hostnames (Origin absent always passes; `null` is always denied). */
    allowedOrigins: z.array(z.string().min(1).max(255)).max(20).default([]),
    limits: LimitsSchema.default(DEFAULT_LIMITS),
    /** Additional owner-defined secret deny globs (gitignore syntax, workspace-relative). */
    secretDeny: z.array(z.string().min(1).max(256)).max(200).default([]),
    /** 'auto' prefers ripgrep from trusted PATH; 'js' forces the bounded JS fallback (regex via a time-capped worker). */
    searchBackend: z.enum(['auto', 'js']).default('auto'),
    /** Explicit exceptions to the secret deny list (gitignore syntax), e.g. ".env.example". */
    secretAllow: z.array(z.string().min(1).max(256)).max(50).default([]),
    /**
     * OS sandbox for run_command / run_commands (macOS sandbox-exec, Linux bwrap):
     * 'off' = never; 'prefer' = use when available; 'require' = refuse when unavailable.
     */
    commandSandbox: z.enum(['off', 'prefer', 'require']).default('off'),
    /** Extra absolute paths writable inside the sandbox (caches etc.), besides the workspace and temp dirs. */
    sandboxWritablePaths: z.array(z.string().min(1).max(1024)).max(50).default([]),
    /** Allow the fetch_url tool (outbound HTTPS from this machine, SSRF-guarded). Off by default. */
    allowWebFetch: z.boolean().default(false),
    /** Owner-installed language servers by language id (python, go, rust, ...). Each runs as your user. */
    lsp: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        z
          .object({
            command: z.string().min(1).max(512),
            args: z.array(z.string().max(512)).max(32).default([]),
            extensions: z.array(z.string().regex(/^\.[a-z0-9]{1,10}$/)).min(1).max(20),
          })
          .strict(),
      )
      .default({}),
    /** Extra env var NAMES (not values) allowed through to child jobs. */
    envAllowlist: z.array(z.string().regex(/^[A-Z0-9_]{1,64}$/)).max(100).default([]),
    logRetentionDays: z.number().int().min(1).max(365).default(7),
    /**
     * 'personal' is the single-owner fast path: an owner-approved OAuth
     * installation can use every owner-registered project according to the
     * token/profile scopes, without duplicate project ACL and AI allowlists.
     * 'managed' restores explicit per-project ACL/trust/egress controls.
     */
    accessMode: z.enum(['personal', 'managed']).default('personal'),
    /**
     * MCP tool exposure override. Unset = transport default (HTTP serves the
     * COMPACT gateway surface, STDIO serves the FULL per-tool catalog).
     * 'hybrid' = 49 tools: the compact coverage core plus 29 direct coding tools.
     * Changes only which tool definitions are listed — never permissions,
     * scopes, trust, approvals or guards.
     */
    toolSurface: z.enum(['compact', 'full', 'hybrid']).optional(),
    /**
     * Expose the four sub-agent operations to MCP clients. Off by default to
     * keep routine client catalogs focused; the owner-only web workbench can
     * still create and manage runs. Takes effect after restarting DODO and
     * rescanning the MCP client. This changes exposure only, never authority.
     */
    exposeSubagentsToMcp: z.boolean().default(false),
    /** Owner catalog preference for discover/Compact/Hybrid; never a permission change. */
    disabledDiscoverOperations: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
      .max(200)
      .refine((values) => new Set(values).size === values.length, 'operation names must be unique')
      .default([]),
    /** Local-owner Cloudflare Tunnel process configuration; contains no token. */
    tunnel: TunnelConfigSchema.default({ connectionMode: 'local', metricsPort: 21732, maxRestarts: 2 }),
    /** Last owner-selected registry entry. This is a startup preference, never authority. */
    startupProjectId: z.string().regex(/^prj_[0-9a-hjkmnp-tv-z]{8,64}$/).optional(),
    /**
     * Local-only escape hatch for tests/dev: allow an http:// publicUrl.
     * Never set this for real deployments.
     */
    dangerouslyAllowInsecurePublicUrl: z.boolean().default(false),
  })
  .strict();

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = GlobalConfigSchema.parse({});

/** Normalize only known pre-connectionMode Tunnel fields before strict parsing. */
export function migrateLegacyGlobalConfig(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const owner: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  const tunnel = owner['tunnel'];
  if (!tunnel || typeof tunnel !== 'object' || Array.isArray(tunnel)) return owner;
  const old = tunnel as Record<string, unknown>;
  const connectionMode = old['connectionMode'] === 'local' || old['connectionMode'] === 'external' || old['connectionMode'] === 'tunnel'
    ? old['connectionMode']
    : old['mode'] === 'managed' && old['credentialRef'] !== undefined
      ? 'tunnel'
      : old['mode'] === 'external'
        ? 'external'
        : 'local';
  const migrated: Record<string, unknown> = { ...old, connectionMode };
  delete migrated['mode'];
  delete migrated['startWithDodo'];
  owner['tunnel'] = migrated;
  return owner;
}

export function loadGlobalConfig(configFile: string): GlobalConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_GLOBAL_CONFIG;
    throw new DodoError('INTERNAL_ERROR', `cannot read global config: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fail closed: a corrupt trusted config must not silently fall back to defaults
    // that could differ from what the owner intended (CFG-04).
    throw new DodoError('INTERNAL_ERROR', 'global config is corrupt JSON; fix or remove it', {
      recovery: `inspect ${configFile}`,
    });
  }
  // 1.0.2 used run-scoped Tunnel tokens. Migrate an old configured managed
  // credential to the persistent Tunnel selection; every other old config is
  // local so an upgrade can never expose the machine by surprise.
  parsed = migrateLegacyGlobalConfig(parsed);
  const result = GlobalConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new DodoError('INTERNAL_ERROR', `global config invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data;
}

export function saveGlobalConfig(configFile: string, config: GlobalConfig): void {
  const data = JSON.stringify(GlobalConfigSchema.parse(config), null, 2) + '\n';
  fs.writeFileSync(configFile, data, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(configFile, 0o600);
    } catch {
      /* best effort */
    }
  }
}

export function effectiveLimits(config: GlobalConfig): Limits {
  return config.limits;
}

/** publicUrl must be a clean origin (https, no path/query/fragment). */
export function validatePublicUrl(publicUrl: string, allowInsecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new DodoError('INVALID_INPUT', 'publicUrl is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new DodoError('INVALID_INPUT', 'publicUrl must be https:// (http only with dangerouslyAllowInsecurePublicUrl for local tests)');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new DodoError('INVALID_INPUT', 'publicUrl must be an origin only (no path, query, fragment, or credentials)');
  }
  return url;
}
