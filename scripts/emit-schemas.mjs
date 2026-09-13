// Generates schemas/*.json from the SINGLE source of truth (the registered
// tool catalog and config Zod schemas), so the wire contract can never drift
// from the handlers (PACK-06). Run as part of `npm run build`.
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'schemas');
fs.mkdirSync(outDir, { recursive: true });

const { TOOL_CATALOG } = await import(path.join(root, 'dist/tools/catalog.js'));
const { COMPACT_CATALOG, HYBRID_CATALOG, HYBRID_DIRECT_OPERATIONS, GATEWAY_OPERATIONS, surfaceStats } = await import(path.join(root, 'dist/tools/surface.js'));
const { toolInputShape } = await import(path.join(root, 'dist/tools/context.js'));
const { envelopeSchema } = await import(path.join(root, 'dist/tools/envelope.js'));
const { GlobalConfigSchema } = await import(path.join(root, 'dist/config/globalConfig.js'));
const { ProjectConfigSchema } = await import(path.join(root, 'dist/config/projectConfig.js'));

const tools = TOOL_CATALOG.map((def) => {
  const inputShape = toolInputShape(def);
  const inputSchema = z.toJSONSchema(z.object(inputShape).strict(), { target: 'draft-2020-12' });
  const outputSchema = z.toJSONSchema(envelopeSchema(def.output), { target: 'draft-2020-12' });
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    requiredScope: def.requiredScope,
    annotations: def.annotations,
    inputSchema,
    outputSchema,
  };
});

const catalog = {
  $comment: 'GENERATED from src/tools — do not edit by hand. Proposed DODO tool contract, not the MCP protocol spec.',
  version: 1,
  toolCount: tools.length,
  tools,
};

writeJson('tools.json', catalog);

const allowlists = new Map(GATEWAY_OPERATIONS.map((g) => [g.name, g]));
const compactTools = COMPACT_CATALOG.map((def) => {
  const inputShape = toolInputShape(def);
  const inputSchema = z.toJSONSchema(z.object(inputShape).strict(), { target: 'draft-2020-12' });
  const outputSchema = z.toJSONSchema(envelopeSchema(def.output), { target: 'draft-2020-12' });
  const gateway = allowlists.get(def.name);
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    requiredScope: def.requiredScope,
    annotations: def.annotations,
    ...(gateway ? { domain: gateway.domain, operations: [...gateway.operations] } : {}),
    inputSchema,
    outputSchema,
  };
});
writeJson('tools.compact.json', {
  $comment: 'GENERATED from src/tools — do not edit by hand. Compact gateway surface (default for HTTP); every operation routes through the full tool contract in tools.json.',
  version: 1,
  toolCount: compactTools.length,
  fullToolCount: TOOL_CATALOG.length,
  stats: { compact: surfaceStats('compact'), hybrid: surfaceStats('hybrid'), full: surfaceStats('full') },
  tools: compactTools,
});

const hybridTools = HYBRID_CATALOG.map((def) => {
  const inputShape = toolInputShape(def);
  const inputSchema = z.toJSONSchema(z.object(inputShape).strict(), { target: 'draft-2020-12' });
  const outputSchema = z.toJSONSchema(envelopeSchema(def.output), { target: 'draft-2020-12' });
  const gateway = allowlists.get(def.name);
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    requiredScope: def.requiredScope,
    annotations: def.annotations,
    ...(gateway ? { domain: gateway.domain, operations: [...gateway.operations] } : {}),
    inputSchema,
    outputSchema,
  };
});
writeJson('tools.hybrid.json', {
  $comment: 'GENERATED from src/tools — do not edit by hand. Hybrid 49-tool surface (opt-in): the compact coverage core first, then 30 direct coding tools; identical per-operation contract to tools.json.',
  version: 1,
  toolCount: hybridTools.length,
  directOperations: [...HYBRID_DIRECT_OPERATIONS],
  fullToolCount: TOOL_CATALOG.length,
  stats: { compact: surfaceStats('compact'), hybrid: surfaceStats('hybrid'), full: surfaceStats('full') },
  tools: hybridTools,
});
writeJson('global-config.schema.json', z.toJSONSchema(GlobalConfigSchema, { target: 'draft-2020-12' }));
writeJson('project-config.schema.json', z.toJSONSchema(ProjectConfigSchema, { target: 'draft-2020-12' }));

console.log(`[dodo] wrote schemas for ${tools.length} tools (full) + ${compactTools.length} (compact) + ${hybridTools.length} (hybrid) + 2 config schemas to schemas/`);

function writeJson(name, value) {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n');
}
