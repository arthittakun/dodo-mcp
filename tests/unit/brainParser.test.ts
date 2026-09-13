import { afterEach, describe, expect, it } from 'vitest';
import { BrainParser } from '../../src/services/brain/brainParser.js';
import { DEFAULT_LIMITS } from '../../src/config/limits.js';

describe('Project Brain bounded parser', () => {
  const parsers: BrainParser[] = [];
  afterEach(async () => { await Promise.all(parsers.splice(0).map((parser) => parser.close())); });

  function parser(): BrainParser {
    const value = new BrainParser(DEFAULT_LIMITS);
    parsers.push(value);
    return value;
  }

  it('extracts TypeScript symbols, imports, references, routes and tests without executing source', async () => {
    const parsed = await parser().parse('src/api.ts', `
      import { helper } from './helper.js';
      export class Api { run() { return helper(); } }
      app.get('/health', () => ({ ok: true }));
      test('health route', () => helper());
      throw new Error('source must never execute');
    `);
    expect(parsed).toMatchObject({ provider: 'typescript-ast', language: 'typescript', truncated: false });
    expect(parsed.symbols.map((item) => [item.kind, item.qualifiedName])).toEqual(expect.arrayContaining([
      ['class', 'Api'], ['method', 'Api.run'],
    ]));
    expect(parsed.imports).toContainEqual(expect.objectContaining({ specifier: './helper.js', kind: 'imports' }));
    expect(parsed.references.some((item) => item.name === 'helper' && item.call)).toBe(true);
    expect(parsed.routes).toContainEqual(expect.objectContaining({ method: 'GET', route: '/health' }));
    expect(parsed.tests).toContainEqual(expect.objectContaining({ kind: 'test', name: 'health route' }));
  });

  it('parses bounded package dependencies and records syntax failures as evidence', async () => {
    const pkg = await parser().parse('package.json', JSON.stringify({
      dependencies: { zod: '^4' }, devDependencies: { vitest: '^5' }, optionalDependencies: { sharp: '^1' },
    }));
    expect(pkg.dependencies).toEqual([
      { name: 'zod', scope: 'runtime', version: '^4' },
      { name: 'vitest', scope: 'development', version: '^5' },
      { name: 'sharp', scope: 'optional', version: '^1' },
    ]);
    const broken = await parser().parse('src/broken.ts', 'export function broken( {');
    expect(broken.diagnostics.some((item) => item.category === 'error')).toBe(true);
  });
});
