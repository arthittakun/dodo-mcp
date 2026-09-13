import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SegmentedSpool } from '../../src/services/jobs/spool.js';
import { loadProjectConfig } from '../../src/config/projectConfig.js';
import { GlobalConfigSchema, validatePublicUrl } from '../../src/config/globalConfig.js';

describe('SegmentedSpool (JOB-05)', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-spool-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads back written content with correct nextOffset', () => {
    const spool = new SegmentedSpool(dir, 'stdout', 10 * 1024 * 1024);
    spool.write(Buffer.from('hello '));
    spool.write(Buffer.from('world'));
    const r = spool.read(0, 1000);
    expect(r.content).toBe('hello world');
    expect(r.nextOffset).toBe(11);
    expect(r.truncatedBeforeOffset).toBe(0);
  });

  it('drops oldest data past the cap and reports truncatedBeforeOffset', () => {
    const cap = 2 * 1024 * 1024; // 2 segments worth
    const spool = new SegmentedSpool(dir, 'stdout', cap);
    const chunk = Buffer.alloc(512 * 1024, 0x61); // 'a'
    for (let i = 0; i < 8; i++) spool.write(chunk); // 4 MiB total
    expect(spool.totalWritten).toBe(8 * 512 * 1024);
    expect(spool.truncatedBeforeOffset).toBeGreaterThan(0);
    // Reading from 0 auto-advances to the retained window.
    const r = spool.read(0, 1024);
    expect(r.truncatedBeforeOffset).toBe(spool.truncatedBeforeOffset);
    expect(r.nextOffset).toBeGreaterThanOrEqual(spool.truncatedBeforeOffset);
  });
});

describe('project config (CFG-01)', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-pc-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('rejects unknown/authority keys and ignores the file (fails closed)', () => {
    fs.writeFileSync(path.join(dir, '.dodo.json'), JSON.stringify({ auth: 'none', root: '/', trustMode: 'trusted' }));
    const res = loadProjectConfig(dir);
    expect(res.present).toBe(true);
    expect(res.invalidReason).toBeTruthy();
    expect(res.config.tasks).toEqual([]); // empty default, nothing merged
  });

  it('accepts valid hints', () => {
    fs.writeFileSync(path.join(dir, '.dodo.json'), JSON.stringify({ name: 'x', tasks: [{ id: 'unit', title: 'Unit', program: 'npm', args: ['test'] }] }));
    const res = loadProjectConfig(dir);
    expect(res.invalidReason).toBeUndefined();
    expect(res.config.tasks[0]?.id).toBe('unit');
  });

  it('treats malformed JSON as absent-but-present', () => {
    fs.writeFileSync(path.join(dir, '.dodo.json'), '{not json');
    const res = loadProjectConfig(dir);
    expect(res.invalidReason).toContain('JSON');
  });
});

describe('global config validation', () => {
  it('publicUrl must be https origin only (no path/query)', () => {
    expect(() => validatePublicUrl('https://dodo.example.com', false)).not.toThrow();
    expect(() => validatePublicUrl('http://dodo.example.com', false)).toThrow(/https/);
    expect(() => validatePublicUrl('http://dodo.example.com', true)).not.toThrow();
    expect(() => validatePublicUrl('https://dodo.example.com/mcp', false)).toThrow(/origin only/);
    expect(() => validatePublicUrl('https://u:p@dodo.example.com', false)).toThrow(/origin only/);
  });

  it('CFG-01: global schema rejects unknown keys', () => {
    expect(() => GlobalConfigSchema.parse({ publicUrl: 'https://x.com', evil: true })).toThrow();
  });
});
