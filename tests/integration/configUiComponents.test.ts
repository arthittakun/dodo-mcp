import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { describe, it, expect } from 'vitest';
import { launch } from '../helpers/testServer.js';

/**
 * Local Config UI components in real Chromium (UI-01..):
 * accessible tooltips, SweetAlert2 confirmations (vendored, same origin, CSP
 * 'self'), double-submit protection, personal-vs-managed visibility, theme
 * cycle, reduced motion, narrow viewports and text-only rendering of
 * malicious names. Fixtures only — never the owner's real state.
 */
describe.skipIf(!fs.existsSync(chromium.executablePath()))('local config UI components in Chromium', () => {
  const evidence = path.resolve('release-evidence/ai-workbench');

  async function collectProblems(page: Page) {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror:${e.name}`));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' || /Content Security Policy/i.test(text)) problems.push(`console:${text.slice(0, 200)}`);
    });
    return problems;
  }

  it('UI-01: tooltips open on focus/hover/tap, close on Escape/outside, and stay inside the viewport with correct ARIA', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0 });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems = await collectProblems(page);
    try {
      await page.goto(ctx.configUrl!);
      await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click();
      const tip = page.locator('#card-workspace .help-tip').first();

      // Keyboard focus opens; aria-describedby points at the shared role=tooltip node.
      await tip.focus();
      const bubble = page.locator('#dodo-tooltip');
      await bubble.waitFor({ state: 'visible' });
      expect(await bubble.getAttribute('role')).toBe('tooltip');
      expect(await tip.getAttribute('aria-describedby')).toBe('dodo-tooltip');
      expect(await tip.getAttribute('aria-expanded')).toBe('true');
      expect(((await bubble.textContent()) ?? '').length).toBeGreaterThan(20);
      // Never covered by the page and never off-screen.
      const box = (await bubble.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

      // Escape closes and restores ARIA state.
      await page.keyboard.press('Escape');
      await bubble.waitFor({ state: 'hidden' });
      expect(await tip.getAttribute('aria-describedby')).toBeNull();
      expect(await tip.getAttribute('aria-expanded')).toBe('false');

      // Tap/click toggles (mobile path); clicking outside closes.
      await tip.click();
      await bubble.waitFor({ state: 'visible' });
      await page.mouse.click(10, 400);
      await bubble.waitFor({ state: 'hidden' });

      // Hover opens too, and the tooltip element never captures pointer events.
      await tip.hover();
      await bubble.waitFor({ state: 'visible' });
      expect(await page.evaluate('getComputedStyle(document.getElementById("dodo-tooltip")).pointerEvents')).toBe('none');

      // The title attribute is not the tooltip mechanism.
      expect(await tip.getAttribute('title')).toBeNull();
      expect(problems).toEqual([]);
    } finally {
      await browser.close();
      await ctx.cleanup();
    }
  }, 45000);

  it('UI-02: SweetAlert2 confirmations gate destructive actions (cancel = no call, confirm = one call), saves are double-submit safe, and malicious names stay text', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0 });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems = await collectProblems(page);
    try {
      await page.addInitScript(`(() => {
        const counts = {};
        window.__apiCounts = counts;
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (((init && init.method) || 'GET') === 'POST') counts[url] = (counts[url] || 0) + 1;
          return original(input, init);
        };
      })();`);
      await page.goto(ctx.configUrl!);
      await page.getByRole('button', { name: 'Providers & Profiles', exact: true }).click();

      // Create a connection whose name is hostile markup — must render as text.
      const evilName = '<img src=x onerror="window.pwned3=1">';
      await page.locator('#wb-body select[name=provider]').selectOption('custom');
      await page.locator('#wb-body input[name=name]').fill(evilName);
      await page.locator('#wb-body input[name=baseUrl]').fill('http://127.0.0.1:9/v1');
      await page.locator('#wb-body input[name=private]').check(); // loopback target needs the explicit opt-in
      // Synchronous double-click: the second click lands on a disabled busy button.
      await page.evaluate('(() => { const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "บันทึก connection"); save.click(); save.click(); })()');
      await page.getByRole('heading', { name: evilName, exact: true }).waitFor();
      expect(await page.evaluate('Boolean(window.pwned3)')).toBe(false);
      const counts = () => page.evaluate('window.__apiCounts') as Promise<Record<string, number>>;
      expect((await counts())['/api/ai/connection']).toBe(1);

      // Deleting asks first; cancel never reaches the backend.
      await page.getByRole('button', { name: 'ลบ connection', exact: true }).click();
      await page.locator('.swal2-cancel').click();
      await page.locator('.swal2-popup').waitFor({ state: 'hidden' });
      expect((await counts())['/api/ai/remove']).toBeUndefined();
      await page.getByRole('heading', { name: evilName, exact: true }).waitFor();

      // Confirm calls the backend exactly once and the connection disappears.
      await page.getByRole('button', { name: 'ลบ connection', exact: true }).click();
      await page.locator('.swal2-confirm').click();
      await page.getByText('ยังไม่มี provider เพิ่ม connection เพื่อเริ่มต้น').waitFor();
      expect((await counts())['/api/ai/remove']).toBe(1);
      expect(problems).toEqual([]);
    } finally {
      await browser.close();
      await ctx.cleanup();
    }
  }, 45000);

  it('UI-03: personal mode hides the per-project permission ceremony; theme cycle, reduced motion and 320px stay usable', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0, configPatch: { accessMode: 'personal' } });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems = await collectProblems(page);
    fs.mkdirSync(evidence, { recursive: true });
    try {
      await page.goto(ctx.configUrl!);
      // Overview announces personal mode and the next steps checklist.
      await page.getByText(/โหมดส่วนตัว/).first().waitFor();
      await page.getByText('ขั้นตอนถัดไป', { exact: true }).waitFor();

      // Projects page: ACL and trust forms are hidden, replaced by one note.
      await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click();
      await page.locator('#personal-note').waitFor({ state: 'visible' });
      expect(await page.locator('#card-perm').isVisible()).toBe(false);
      expect(await page.locator('#card-clients').isVisible()).toBe(false);
      expect(await page.locator('#wb-body select[name=trust]').count()).toBe(0);

      // Settings still offers switching to managed mode (SweetAlert-confirmed).
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'เปลี่ยนเป็นโหมดแยกสิทธิ์', exact: true }).waitFor();
      // Managed-only controls must appear again after an actual mode switch.
      await page.getByRole('button', { name: 'เปลี่ยนเป็นโหมดแยกสิทธิ์', exact: true }).click();
      await page.locator('.swal2-confirm').click();
      await page.getByRole('button', { name: 'ใช้โหมดส่วนตัวแบบเพิ่มแล้วใช้ได้เลย', exact: true }).waitFor();
      await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click();
      await page.locator('#card-perm').waitFor({ state: 'visible', timeout: 60_000 });
      expect(await page.locator('#card-clients').isVisible()).toBe(true);
      expect(await page.locator('#personal-note').isVisible()).toBe(false);

      // Theme cycle dark → light → system persists per browser.
      const theme = () => page.locator('html').getAttribute('data-theme');
      expect(await theme()).toBe('dark');
      await page.locator('#theme-toggle').click();
      expect(await theme()).toBe('light');
      await page.locator('#theme-toggle').click(); // system
      expect(await page.evaluate('localStorage.getItem("dodo-theme")')).toBe('system');
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect.poll(() => page.locator('html').getAttribute('data-theme'), { timeout: 5000 }).toBe('dark');

      // Reduced motion: helper reports it and toasts render without animation.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(await page.evaluate('window.DodoUI.reducedMotion()')).toBe(true);
      await page.evaluate('window.DodoUI.alerts.toast("success","ทดสอบ reduced motion")');
      const toast = page.locator('.swal2-toast');
      await toast.waitFor({ state: 'visible' });
      expect(await page.evaluate('getComputedStyle(document.querySelector(".swal2-toast")).animationName')).toBe('none');

      // 320px: no horizontal scrolling, navigation still reachable.
      await page.setViewportSize({ width: 320, height: 700 });
      await page.getByRole('button', { name: 'ภาพรวม', exact: true }).click();
      await page.getByText('ขั้นตอนถัดไป', { exact: true }).waitFor();
      expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
      await page.screenshot({ path: path.join(evidence, 'overview-320.png'), fullPage: true });
      expect(problems).toEqual([]);
    } finally {
      await browser.close();
      await ctx.cleanup();
    }
  }, 90000);

  it('UI-04: owner can toggle MCP sub-agent exposure while web Chat & Tasks stays available', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0, configPatch: { exposeSubagentsToMcp: false } });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const problems = await collectProblems(page);
    try {
      await page.goto(ctx.configUrl!);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('heading', { name: /Sub-agent tools ใน MCP/ }).waitFor();
      const toggle = page.getByLabel('เปิดให้ MCP clients เห็น Sub-agent tools', { exact: true });
      expect(await toggle.isChecked()).toBe(false);
      await page.getByText('สถานะที่บันทึก: ปิด', { exact: true }).waitFor();

      await toggle.check();
      await page.getByRole('button', { name: 'บันทึกการมองเห็น tools', exact: true }).click();
      await page.locator('.swal2-confirm').click();
      await page.getByText(/สถานะที่บันทึก: เปิด · ต้อง restart DODO/).waitFor();
      await page.getByText('เปิดอยู่: AI ภายนอกมองเห็น operations สำหรับสร้างและจัดการ sub-agent', { exact: true }).waitFor();
      expect(JSON.parse(fs.readFileSync(path.join(ctx.configDir, 'config.json'), 'utf8')).exposeSubagentsToMcp).toBe(true);
      fs.mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, 'subagent-tools-switch.png'), fullPage: true });

      // The switch controls external MCP exposure only; owner web tasks remain present.
      await page.getByRole('button', { name: 'Chat & Tasks', exact: true }).click();
      await page.getByRole('heading', { name: 'Chat & Tasks', exact: true }).waitFor();
      expect(problems).toEqual([]);
    } finally {
      await browser.close();
      await ctx.cleanup();
    }
  }, 45000);

  it('UI-05: connection mode is exclusive, reports the active endpoint, and refuses an unready Tunnel selection', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0, connectionMode: 'local' });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const problems = await collectProblems(page);
    try {
      await page.goto(ctx.configUrl!);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();

      expect(await page.locator('#conn-active').textContent()).toBe(`http://127.0.0.1:${ctx.port}/mcp`);
      expect(await page.locator('#conn-local').textContent()).toBe(`http://127.0.0.1:${ctx.port}/mcp`);
      expect(await page.locator('#tunnel-mode-local').isChecked()).toBe(true);
      expect(await page.locator('#tunnel-mode-tunnel').isChecked()).toBe(false);

      // The fixture has only an intentionally insecure loopback origin and no
      // stored credential. Selecting Tunnel must fail without changing the
      // saved mode or displaying a canned success message.
      await page.locator('#tunnel-mode-tunnel').check();
      await page.locator('#tunnel-save').click();
      await expect.poll(() => page.locator('#tunnel-error').textContent()).toContain('publicUrl must be https://');
      expect(JSON.parse(fs.readFileSync(path.join(ctx.configDir, 'config.json'), 'utf8')).tunnel.connectionMode).toBe('local');

      // A refresh restores the authoritative persisted selection.
      await page.locator('#refresh').click();
      await expect.poll(() => page.locator('#tunnel-mode-local').isChecked()).toBe(true);
      expect(await page.locator('#tunnel-mode-tunnel').isChecked()).toBe(false);
      const expectedHttpErrors = problems.filter((problem) => problem.includes('status of 400'));
      expect(expectedHttpErrors).toHaveLength(1);
      expect(problems.filter((problem) => !problem.includes('status of 400'))).toEqual([]);
    } finally {
      await browser.close();
      await ctx.cleanup();
    }
  }, 45000);
});
