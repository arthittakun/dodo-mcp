import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { menuText, runCliMenu, type CliMenuActions, type CliMenuProject } from '../../src/cli/menu.js';

const project: CliMenuProject = {
  projectId: 'prj_abcdefgh',
  displayName: 'Web app',
  root: '/tmp/web-app',
  available: true,
  statusText: 'ready',
};

function actions(events: string[]): CliMenuActions {
  return {
    listProjects: () => [project],
    startupProject: () => project,
    selectProject: (id) => { events.push(`select:${id}`); return project; },
    addProject: (root, name) => { events.push(`add:${root}:${name ?? ''}`); return { ...project, root, displayName: name ?? project.displayName }; },
    start: async (root) => { events.push(`start:${root ?? 'none'}`); },
    openRemoteConfig: async () => { events.push('web'); },
    setupAll: async () => { events.push('setup'); },
    checkSetup: async () => { events.push('check'); },
  };
}

async function run(input: string, events: string[]): Promise<string> {
  const output = new PassThrough();
  const source = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += String(chunk); });
  const pending = runCliMenu(actions(events), { input: source, output });
  for (const line of input.split('\n').slice(0, -1)) {
    source.write(`${line}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  source.end();
  await pending;
  return text;
}

describe('interactive CLI menu', () => {
  it('shows the saved project and the cloudflared-inclusive setup action', () => {
    const text = menuText(project);
    expect(text).toContain('Web app (/tmp/web-app)');
    expect(text).toContain('DODO');
    expect(text).toContain('cloudflared');
  });

  it('starts the remembered project and can select a different registered entry', async () => {
    const direct: string[] = [];
    await run('1\n', direct);
    expect(direct).toEqual(['start:/tmp/web-app']);

    const selected: string[] = [];
    await run('2\n1\n', selected);
    expect(selected).toEqual(['select:prj_abcdefgh', 'start:/tmp/web-app']);
  });

  it('adds an absolute path before starting and exits without side effects', async () => {
    const added: string[] = [];
    await run('3\n/tmp/new-app\nNew app\n', added);
    expect(added).toEqual(['add:/tmp/new-app:New app', 'start:/tmp/new-app']);

    const exited: string[] = [];
    await run('0\n', exited);
    expect(exited).toEqual([]);
  });

  it('can open the temporary Remote Config flow from the owner menu', async () => {
    const events: string[] = [];
    await run('4\n', events);
    expect(events).toEqual(['web']);
  });
});
