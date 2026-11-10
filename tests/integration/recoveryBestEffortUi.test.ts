import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { RecoveryPolicySchema } from '../../src/services/recovery/contracts.js';

const executablePath = process.env['DODO_TEST_CHROMIUM_EXECUTABLE'] ?? chromium.executablePath();

describe.skipIf(!fs.existsSync(executablePath))('Recovery best-effort owner UI', () => {
  it('keeps unavailable backups visible, removes legacy strict blocking, and persists the secret-skip preference', async () => {
    const browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.setContent('<main id="panel"></main>');
      const status = {
        state: 'BLOCKED', operationsBlocked: false, enabled: true, effectiveMode: 'snapshot', hasGitRepo: false,
        awaitingActivation: true, lastCheckedAt: null, lastTrigger: null, errorCode: 'SECRET_PATH_DENIED',
        errorDetail: 'source backup unavailable', lastWarning: 'latest operation has no new Recovery checkpoint',
        blockedPath: 'scripts/setup-env.sh', skippedSecretFiles: ['examples/fixture.ts'],
        policy: RecoveryPolicySchema.parse({ strictEnforcement: true, skipSecretContentFiles: false }),
        counts: { included: 0, excludedByPolicy: 1 }, progress: { scanned: 2 }, projectBytes: 0,
        git: { state: 'unavailable' }, drift: { state: 'unavailable', errorCode: 'RESOURCE_LIMIT', changedCount: 0 },
      };
      await page.addScriptTag({ content: `window.__recoveryStatus = ${JSON.stringify(status)};` });
      await page.addScriptTag({ content: fs.readFileSync(path.resolve('src/server/configUi/ui/recovery.js'), 'utf8') });
      // Exercise the actual dashboard, inputs and click handlers. Other panels
      // return empty read results so the fixture stays independent of a server.
      await page.evaluate(`(async () => {
        const el = (tag, text, cls) => { const node = document.createElement(tag); if(text !== undefined) node.textContent = text; if(cls) node.className = cls; return node; };
        const section = (title, description) => { const node = el('section'); node.append(el('h2', title)); if(description) node.append(el('p', description)); return node; };
        const field = (form, label, name, value = '', type = 'text') => { const row = el('label', label), input = el(type === 'textarea' ? 'textarea' : 'input'); input.name = name; if(type !== 'textarea') input.type = type; input.value = String(value); row.append(input); form.append(row); return input; };
        const check = (form, label, name, checked = false) => { const row = el('label'), input = el('input'); input.type = 'checkbox'; input.name = name; input.checked = checked; row.append(input, document.createTextNode(label)); form.append(row); return input; };
        const choice = (form, label, name, options, value) => { const row = el('label', label), input = el('select'); input.name = name; for(const [id, text] of options) { const option = el('option', text); option.value = id; input.append(option); } input.value = value; row.append(input); form.append(row); return input; };
        const button = (label, action) => { const node = el('button', label); node.type = 'button'; node.onclick = () => { Promise.resolve(action()).catch(error => { window.__actionError = error.message; }); }; return node; };
        window.__savedPolicies = []; window.__notices = []; window.__apiCalls = [];
        const api = async (route, body) => {
          window.__apiCalls.push({ route, body });
          if(route !== 'admin/action' || body.projectId !== 'fixture') throw new Error('unexpected API route or project');
          if(body.operation === 'recovery.status') return window.__recoveryStatus;
          if(body.operation === 'recovery.git.status') return { isRepo: false };
          if(body.operation === 'recovery.configure') { window.__savedPolicies.push(body.args.policy); return { enabled: true }; }
          if(body.operation === 'recovery.reset') return window.__recoveryStatus;
          if(body.operation === 'recovery.evidence.list') return { items: [], pointers: [], pointerEvents: { items: [] }, nextCursor: null };
          if(body.operation === 'recovery.checkpoint_list') return { items: [], nextCursor: null };
          throw new Error('unexpected operation: ' + body.operation);
        };
        window.DodoRecoveryMaintenance = async () => {};
        const panel = window.DodoRecovery({ el, section, button, check, field, choice, api,
          notice: message => window.__notices.push(message), confirmDanger: async () => true,
          help: text => el('p', text), refresh: async () => {},
          getSelected: () => ({ projectId: 'fixture', workspaceId: 'workspace', workspaceEpoch: 'epoch' }) });
        await panel(document.getElementById('panel'));
      })()`);

      const panel = page.locator('#panel');
      expect(await panel.locator('[role=status]').textContent()).toContain('สำรองไม่พร้อม — ยังแก้ไฟล์และรันคำสั่งได้ตามสิทธิ์เดิม');
      expect(await panel.locator('input[name=recoveryStrict]').count()).toBe(0);
      expect(await panel.textContent()).not.toContain('Strict Blocking');
      expect(await panel.textContent()).not.toContain('หยุดการเปลี่ยน source');
      expect(await panel.getByRole('button', { name: /Secret Allow|Allow All|อนุญาตทุกไฟล์/ }).count()).toBe(0);
      await panel.getByText('scripts/setup-env.sh', { exact: true }).waitFor();
      await panel.getByText('examples/fixture.ts', { exact: true }).waitFor();
      await panel.getByText('latest operation has no new Recovery checkpoint', { exact: true }).waitFor();
      const skip = panel.locator('input[name=recoverySkipSecrets]');
      expect(await skip.isChecked()).toBe(false);
      await panel.getByRole('button', { name: 'บันทึกการสำรอง', exact: true }).click();
      await expect.poll(() => page.evaluate('window.__savedPolicies.length')).toBe(1);
      expect(await page.evaluate('window.__savedPolicies[0]')).toMatchObject({ strictEnforcement: false, skipSecretContentFiles: false });
      await skip.check();
      await panel.getByRole('button', { name: 'บันทึกการสำรอง', exact: true }).click();
      await expect.poll(() => page.evaluate('window.__savedPolicies.length')).toBe(2);
      expect(await page.evaluate('window.__savedPolicies[1]')).toMatchObject({ strictEnforcement: false, skipSecretContentFiles: true });

      await panel.getByRole('button', { name: 'ข้ามไฟล์ที่มีเนื้อหาคล้าย Secret ในการสำรอง', exact: true }).click();
      await expect.poll(() => page.evaluate('window.__savedPolicies.length')).toBe(3);
      expect(await page.evaluate('window.__savedPolicies[2]')).toMatchObject({ strictEnforcement: false, skipSecretContentFiles: true, scanContentSecrets: true });
      await expect.poll(() => page.evaluate('window.__notices.at(-1)')).toContain('ยังสำรองไม่ได้');
      expect(await page.evaluate('window.__apiCalls.every(call => call.route === "admin/action" && call.body.projectId === "fixture")')).toBe(true);

      await panel.getByRole('button', { name: 'ลองสำรองใหม่', exact: true }).click();
      await expect.poll(() => page.evaluate('window.__notices.at(-1)')).toContain('ยังสำรองไม่ได้');
      expect(await page.evaluate('window.__actionError')).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
