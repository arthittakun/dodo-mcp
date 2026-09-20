import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { GitService } from '../../src/services/git/gitService.js';
import { WorkspaceFS } from '../../src/workspace/fs.js';

describe('R00 whole-index Git safety', () => {
  let f: ReturnType<typeof platformFixture>;
  const git = (...args: string[]) => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const index = () => fs.readFileSync(path.join(f.root, '.git/index'));
  beforeEach(() => {
    f = platformFixture(); git('init'); git('config', 'user.name', 'DODO fixture'); git('config', 'user.email', 'fixture@example.test');
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'base'); git('add', 'a.txt'); git('commit', '-m', 'fixture baseline');
  });
  afterEach(async () => { await f?.close(); });

  it('rejects a previously staged secret and preserves HEAD and the index byte-for-byte', async () => {
    fs.writeFileSync(path.join(f.root, '.env'), 'DUMMY=fixture'); git('add', '-f', '.env');
    const before = index(), head = git('rev-parse', 'HEAD'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'edit');
    await expect(f.ws.services.git.commit({ message: 'must fail', paths: ['a.txt'] })).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
    expect(index()).toEqual(before); expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('directory path staging cannot smuggle a denied descendant into a commit', async () => {
    fs.mkdirSync(path.join(f.root, 'folder')); fs.writeFileSync(path.join(f.root, 'folder/ok.ts'), 'ok'); fs.writeFileSync(path.join(f.root, 'folder/.env'), 'DUMMY=fixture');
    const before = index(), head = git('rev-parse', 'HEAD');
    await expect(f.ws.services.git.commit({ message: 'must fail', paths: ['folder'] })).rejects.toMatchObject({ code: 'SECRET_PATH_DENIED' });
    expect(index()).toEqual(before); expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('all stages individual safe leaves, excluding nested secrets and symlinks', async () => {
    fs.mkdirSync(path.join(f.root, 'folder'));
    fs.writeFileSync(path.join(f.root, 'folder/ok.ts'), 'ok');
    fs.writeFileSync(path.join(f.root, 'folder/.env'), 'DUMMY=fixture');
    if (process.platform !== 'win32') fs.symlinkSync('../a.txt', path.join(f.root, 'folder/link'));
    const result = await f.ws.services.git.commit({ message: 'safe all', all: true });
    expect(result.stagedPaths).toContain('folder/ok.ts');
    expect(git('ls-files')).not.toContain('.env');
    expect(git('ls-files')).not.toContain('folder/link');
  });

  it('refuses staged sibling-project changes when workspace is a repository subdirectory', async () => {
    fs.mkdirSync(path.join(f.root, 'nested')); fs.writeFileSync(path.join(f.root, 'nested/n.txt'), 'inside'); git('add', 'nested/n.txt');
    fs.writeFileSync(path.join(f.root, 'sibling.txt'), 'outside'); git('add', 'sibling.txt');
    git('config', 'diff.relative', 'true');
    const nestedWfs = new WorkspaceFS(path.join(f.root, 'nested'), f.ws.services.wfs.ignores);
    const nested = new GitService(nestedWfs, f.ws.services.limits); const before = index(), head = git('rev-parse', 'HEAD');
    await expect(nested.commit({ message: 'must fail' })).rejects.toMatchObject({ code: 'PATH_DENIED' });
    expect(index()).toEqual(before); expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('failed hook leaves a partially staged index unchanged', async () => {
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'staged'); git('add', 'a.txt'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'unstaged');
    fs.writeFileSync(path.join(f.root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const before = index(), head = git('rev-parse', 'HEAD');
    await expect(f.ws.services.git.commit({ message: 'must fail', paths: ['a.txt'] })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(index()).toEqual(before); expect(git('show', ':a.txt')).toBe('staged'); expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('unstaged');
    expect(fs.existsSync(path.join(f.root, '.git/index.lock'))).toBe(false);
  });

  it('rechecks repository scope after an external repository boundary change', async () => {
    await f.ws.services.git.status();
    fs.renameSync(path.join(f.root, '.git'), path.join(f.base, 'original-git'));
    const parentGit = (...args: string[]) => execFileSync('git', ['-C', f.base, ...args], { stdio: 'pipe' });
    parentGit('init'); parentGit('config', 'user.name', 'Fixture'); parentGit('config', 'user.email', 'fixture@example.test');
    fs.writeFileSync(path.join(f.base, 'outside.txt'), 'outside'); parentGit('add', 'outside.txt');
    const parentIndex = path.join(f.base, '.git/index'), before = fs.readFileSync(parentIndex);
    await expect(f.ws.services.git.commit({ message: 'must fail' })).rejects.toMatchObject({ code: 'PATH_DENIED' });
    expect(fs.readFileSync(parentIndex)).toEqual(before);
  });

  it('commits allowed staged content without consuming unstaged edits', async () => {
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'staged'); git('add', 'a.txt'); fs.writeFileSync(path.join(f.root, 'a.txt'), 'unstaged');
    const result = await f.ws.services.git.commit({ message: 'allowed staged' });
    expect(result.commit).toBe(git('rev-parse', 'HEAD')); expect(git('show', 'HEAD:a.txt')).toBe('staged');
    expect(git('show', ':a.txt')).toBe('staged'); expect(fs.readFileSync(path.join(f.root, 'a.txt'), 'utf8')).toBe('unstaged');
  });

  it('honors an existing index lock without deleting it', async () => {
    fs.writeFileSync(path.join(f.root, '.git/index.lock'), 'another process');
    await expect(f.ws.services.git.commit({ message: 'busy' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fs.readFileSync(path.join(f.root, '.git/index.lock'), 'utf8')).toBe('another process');
  });
});
