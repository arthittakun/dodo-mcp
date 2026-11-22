import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const python = process.env['DODO_TEST_ANIMATION_PYTHON'];
const helper = fileURLToPath(new URL('../helpers/animation_scene_budget.py', import.meta.url));
const engine = fileURLToPath(new URL('../../engines/animation/', import.meta.url));

describe.skipIf(!python)('scene input decode budgets', () => {
  it('bounds expanding GIF frames before conversion while normal animated scenes still render', () => {
    const result = JSON.parse(execFileSync(python!, ['-I', '-B', '-X', 'utf8', helper, engine], {
      cwd: path.dirname(helper), windowsHide: true, timeout: 15000, encoding: 'utf8',
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ cumulativeExpansionRejected: true, perFrameExpansionRejected: true, frameCapRejected: true, normalFrames: 2, sceneRendered: true });
    expect(result['fixtureBytes']).toBeLessThan(1024);
  });
});
