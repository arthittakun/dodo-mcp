/* DODO Local Config UI. Plain browser JS: no framework, no CDN, no telemetry.
 * Everything rendered from the API goes through textContent / DOM APIs, never
 * through HTML strings, so paths, client names and config values cannot
 * inject markup. */
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'dodo-config-token';
  const THEME_KEY = 'dodo-theme';
  const MODE_LABEL = { inspect: 'inspect', edit: 'edit', trusted: 'trusted' };
  const MODE_TEXT = {
    inspect: 'อ่านได้ แก้/รันต้องขออนุมัติทีละครั้ง',
    edit: 'แก้ไฟล์ได้ทันที รันคำสั่งต้องขออนุมัติ',
    trusted: 'ทำได้ทุกอย่าง คำสั่งรันด้วยสิทธิ์ OS ของคุณ',
  };

  // ---- token (fragment → sessionStorage, fragment stripped from the URL) ----
  let token = '';
  if (location.hash.length > 1) {
    token = location.hash.slice(1);
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (_e) { /* private mode */ }
    history.replaceState(null, '', location.pathname);
  } else {
    try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_e) { token = ''; }
  }

  // ---- theme: dark default, light, system; remembered per browser ----
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const themeBtn = $('theme-toggle');
  const THEME_ORDER = ['dark', 'light', 'system'];
  const THEME_UI = { dark: ['◐', 'มืด'], light: ['☀', 'สว่าง'], system: ['⚙', 'ตามระบบ'] };
  function readTheme() { try { const v = localStorage.getItem(THEME_KEY); return THEME_ORDER.includes(v) ? v : 'dark'; } catch (_e) { return 'dark'; } }
  function applyTheme(pref) {
    const effective = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = effective;
    document.documentElement.dataset.themePref = pref;
    const [icon, label] = THEME_UI[pref];
    themeBtn.textContent = `${icon} ${label}`;
    themeBtn.setAttribute('aria-label', `สลับธีม: ${label}`);
  }
  applyTheme(readTheme());
  mq.addEventListener('change', () => { if (readTheme() === 'system') applyTheme('system'); });
  themeBtn.addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(readTheme()) + 1) % THEME_ORDER.length];
    try { localStorage.setItem(THEME_KEY, next); } catch (_e) { /* ignore */ }
    applyTheme(next);
  });

  // ---- notices (no alert()) ----
  const notice = $('notice');
  let noticeTimer = 0;
  function notify(kind, text, sticky) {
    clearTimeout(noticeTimer);
    notice.dataset.kind = kind;
    notice.querySelector('.notice-icon').textContent = kind === 'success' ? '✓' : kind === 'error' ? '✕' : 'ℹ';
    notice.querySelector('.notice-text').textContent = text;
    notice.hidden = false;
    if (!sticky && kind !== 'error') noticeTimer = setTimeout(() => { notice.hidden = true; }, 8000);
  }
  $('notice-close').addEventListener('click', () => { notice.hidden = true; });

  // ---- confirm dialog ----
  const dialog = $('confirm');
  function confirmAction(title, text, okLabel) {
    return new Promise((resolve) => {
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = text;
      $('confirm-ok').textContent = okLabel || 'ยืนยัน';
      if (typeof dialog.showModal !== 'function') { resolve(window.confirm(text)); return; }
      const onClose = () => { dialog.removeEventListener('close', onClose); resolve(dialog.returnValue === 'ok'); };
      dialog.addEventListener('close', onClose);
      dialog.returnValue = 'cancel';
      dialog.showModal();
    });
  }

  // ---- API ----
  function workspaceContext() {
    return state && state.workspace ? { 'x-dodo-workspace': state.workspace.workspaceId, 'x-dodo-epoch': state.workspace.epoch } : {};
  }
  async function api(path, body, context = workspaceContext()) {
    const headers = { Authorization: `Bearer ${token}`, ...context };
    if (body !== undefined) Object.assign(headers, context, { 'Content-Type': 'application/json' });
    let res;
    try {
      res = await fetch(`/api/${path}`, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store' });
    } catch (_e) {
      const err = new Error('ติดต่อ DODO ไม่ได้ — server อาจปิดอยู่ หรือกำลัง restart');
      err.status = 0;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (_e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data && data.code;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---- busy helper: no double submits ----
  async function withBusy(button, busyLabel, fn) {
    if (button.disabled) return undefined;
    const original = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyLabel) button.textContent = busyLabel;
    try { return await fn(); } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = original;
    }
  }

  // ---- copy ----
  async function copyText(text, button) {
    if (!text) { notify('error', 'ไม่มีค่าให้คัดลอก'); return; }
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (_e2) { ok = false; }
      ta.remove();
    }
    if (ok) {
      const original = button.textContent;
      button.textContent = 'คัดลอกแล้ว ✓';
      setTimeout(() => { button.textContent = original; }, 1500);
    } else {
      notify('error', 'คัดลอกอัตโนมัติไม่ได้ ให้เลือกข้อความแล้วคัดลอกเอง');
    }
  }

  // ---- card state helpers ----
  function cardState(prefix, state, message) {
    const loading = $(`${prefix}-loading`), body = $(`${prefix}-body`), error = $(`${prefix}-error`);
    loading.hidden = state !== 'loading';
    body.hidden = state !== 'ready';
    error.hidden = state !== 'error';
    if (state === 'error') error.textContent = `✕ ${message || 'โหลดข้อมูลไม่สำเร็จ'}`;
  }
  function setChip(id, state, icon, value) {
    const chip = $(id);
    chip.dataset.state = state;
    chip.querySelector('.chip-icon').textContent = icon;
    chip.querySelector('.chip-value').textContent = value;
  }
  function fmtRemaining(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'หมดอายุแล้ว';
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h} ชม. ${m % 60} นาที` : `${m} นาที`;
  }

  // ---- render ----
  let state = null;
  let lastRoot = null;
  let switchedOnce = false;
  let lastSavedMode = null;
  let lastPublicUrl = null;
  let lastClientsSig = null;
  let projectsGeneration = 0;

  /* Background refreshes must never clobber what the owner is editing:
   * form sections are only re-rendered when nothing there is dirty or focused,
   * unless the refresh was user-initiated (force). */
  function render(s, force) {
    if (state && (state.workspace.workspaceId !== s.workspace.workspaceId || state.workspace.epoch !== s.workspace.epoch)) {
      force = true;
      resetClientPicker();
      resetClientManager();
      projectsGeneration++;
      notify('info', 'Workspace เปลี่ยนแล้ว — ล้างค่าที่ยังไม่บันทึก กรุณาตรวจโปรเจกต์ใหม่ก่อนบันทึก', true);
    }
    state = s;
    $('version').textContent = s.version ? `v${s.version}` : '';
    // chips
    const c = s.connection || {};
    if (c.mcpLocalUrl) setChip('chip-mcp', s.state === 'switching' ? 'busy' : 'ok', s.state === 'switching' ? '⟳' : '●', s.state === 'switching' ? 'กำลังสลับ workspace' : `เปิดที่ ${c.mcpLocalUrl.replace(/^http:\/\//, '')}`);
    else setChip('chip-mcp', 'warn', '○', 'ไม่มี HTTP listener ใน entry นี้');
    if (c.oauthConfigured === true) setChip('chip-oauth', 'ok', '●', `เปิดใช้ · ${c.activePublicUrl}`);
    else if (c.oauthConfigured === false) setChip('chip-oauth', 'warn', '⚠', 'LOCKED — ยังไม่ตั้ง public URL');
    else setChip('chip-oauth', 'idle', '○', 'ไม่เกี่ยวกับ entry นี้');
    const remaining = (c.expiresAt || 0) - Date.now();
    setChip('chip-config', remaining > 0 ? 'ok' : 'error', remaining > 0 ? '●' : '✕', remaining > 0 ? `ใช้ได้อีก ${fmtRemaining(remaining)}` : 'token หมดอายุ');
    $('foot-expiry').textContent = fmtRemaining(remaining);

    // workspace
    const w = s.workspace;
    $('ws-name').textContent = w.name || w.root;
    const rootEl = $('ws-root');
    rootEl.textContent = w.root;
    rootEl.title = w.root;
    $('ws-id').textContent = w.workspaceId;
    $('ws-epoch').textContent = w.epoch;
    $('ws-jobs').textContent = w.runningJobs > 0 ? `${w.runningJobs} งาน (สลับ workspace ไม่ได้จนกว่าจะเสร็จหรือถูกยกเลิก)` : 'ไม่มี';
    $('ws-recovery').textContent = w.recoveryRequired > 0 ? `${w.recoveryRequired} รายการ — ดูด้วย dodo recover` : 'ไม่มี';
    const badge = $('ws-state-badge');
    if (s.state === 'switching') { badge.textContent = '⟳ กำลังสลับ'; badge.className = 'badge info'; badge.hidden = false; }
    else if (w.runningJobs > 0) { badge.textContent = `▶ ${w.runningJobs} งานกำลังรัน`; badge.className = 'badge warn'; badge.hidden = false; }
    else { badge.hidden = true; }
    $('ws-switch').disabled = !w.switchSupported || s.state === 'switching';
    $('ws-path').disabled = !w.switchSupported;
    if (!w.switchSupported) $('ws-path-help').textContent = 'entry นี้ (stdio) ผูกกับโฟลเดอร์ที่ client เปิดมา การสลับ workspace ทำได้เฉพาะเมื่อรันด้วย dodo start';
    if (lastRoot !== null && lastRoot !== w.root) switchedOnce = true;
    lastRoot = w.root;
    $('ws-hint').hidden = !switchedOnce;
    cardState('ws', 'ready');
    void loadProjects(force === true);

    const desktop = s.desktop && s.desktop.policy;
    $('desktop-mode').textContent = desktop ? desktop.mode : 'off';
    $('desktop-summary').textContent = desktop && desktop.mode !== 'off'
      ? desktop.persistent
        ? `อนุญาต ${desktop.allowedApps.join(', ')} — จำไว้สำหรับโปรเจกต์นี้จนกว่าจะปิดสิทธิ์`
        : `อนุญาต ${desktop.allowedApps.join(', ')} ถึง ${new Date(desktop.expiresAt).toLocaleTimeString()} (สิทธิ์ของ workspace รอบนี้)`
      : 'การอ่านและควบคุมหน้าต่างปิดอยู่';
    $('desktop-disable').disabled = !desktop || desktop.mode === 'off';

    // permissions
    const p = s.permissions;
    $('perm-saved').textContent = MODE_LABEL[p.savedMode] || p.savedMode;
    const eff = $('perm-effective');
    eff.textContent = MODE_LABEL[p.effectiveMode] || p.effectiveMode;
    if (p.override) {
      const b = document.createElement('span');
      b.className = 'badge warn';
      b.textContent = p.override === 'bypass' ? 'override: --bypass' : 'override: --allow --all';
      eff.append(b);
    }
    const ebadge = $('perm-effective-badge');
    ebadge.hidden = false;
    ebadge.textContent = p.effectiveMode === 'trusted' ? '⚠ trusted: รันด้วยสิทธิ์ OS ของคุณ' : `● ${MODE_TEXT[p.effectiveMode] || p.effectiveMode}`;
    ebadge.className = p.effectiveMode === 'trusted' ? 'badge warn' : 'badge ok';
    const ov = $('perm-override');
    if (p.override) {
      ov.hidden = false;
      $('perm-override-text').textContent = p.override === 'bypass'
        ? 'รอบนี้เปิดด้วย --bypass: ทุก action เป็น trusted และ command sandbox ค่าเริ่มต้นถูกปิด คำสั่งรันด้วยสิทธิ์ OS ของบัญชีคุณโดยไม่ถาม ค่าที่บันทึกด้านล่างจะมีผลก็ต่อเมื่อ restart โดยไม่ใช้ flag'
        : 'รอบนี้เปิดด้วย --allow --all: ทุก action เป็น trusted คำสั่งรันด้วยสิทธิ์ OS ของบัญชีคุณโดยไม่ถาม (sandbox ตาม config) ค่าที่บันทึกด้านล่างจะมีผลก็ต่อเมื่อ restart โดยไม่ใช้ flag';
    } else { ov.hidden = true; }
    const checkedNow = document.querySelector('#perm-form input:checked');
    const permDirty = !force && checkedNow && lastSavedMode !== null && checkedNow.value !== lastSavedMode;
    if (!permDirty) {
      const radio = document.querySelector(`#perm-form input[value="${p.savedMode}"]`);
      if (radio) radio.checked = true;
    }
    lastSavedMode = p.savedMode;
    $('perm-help').textContent = p.override
      ? 'บันทึกได้ แต่สิทธิ์ที่มีผลรอบนี้ยังเป็น trusted จาก override จนกว่าจะ restart โดยไม่ใช้ flag'
      : 'มีผลกับคำขอถัดไป ไม่ยกเลิกงานที่รันอยู่แล้ว';
    cardState('perm', 'ready');

    // connection
    $('conn-local').textContent = c.mcpLocalUrl || 'ไม่มีใน entry นี้';
    $('conn-local-copy').disabled = !c.mcpLocalUrl;
    $('conn-public').textContent = c.mcpPublicUrl || (c.publicUrl ? `${c.publicUrl}/mcp (หลัง restart)` : 'ยังไม่ตั้งค่า');
    $('conn-public-copy').disabled = !(c.mcpPublicUrl || c.publicUrl);
    $('conn-config').textContent = c.localConfigOrigin || location.origin;
    const oauth = $('conn-oauth');
    oauth.replaceChildren();
    const ob = document.createElement('span');
    if (c.oauthConfigured === true) { ob.className = 'badge ok'; ob.textContent = '● เปิดใช้'; oauth.append(ob, document.createTextNode(` issuer ${c.activePublicUrl}`)); }
    else if (c.oauthConfigured === false) { ob.className = 'badge warn'; ob.textContent = '⚠ LOCKED'; oauth.append(ob, document.createTextNode(' ยังไม่มี public URL — MCP ปฏิเสธทุก tool call จนกว่าจะตั้งค่าและ restart')); }
    else { ob.className = 'badge'; ob.textContent = '○ ไม่เกี่ยวกับ entry นี้'; oauth.append(ob); }
    const originInput = $('conn-origin');
    const originDirty = !force && (document.activeElement === originInput || (lastPublicUrl !== null && originInput.value !== lastPublicUrl));
    if (!originDirty) originInput.value = c.publicUrl || '';
    lastPublicUrl = c.publicUrl || '';
    $('conn-restart').hidden = !c.restartRequired;
    cardState('conn', 'ready');

    // clients
    $('clients-root').textContent = s.workspace.root;
    renderClients(s.clients || [], force);
    cardState('clients', 'ready');
    document.getElementById('main').setAttribute('aria-busy', 'false');
  }

  // ---- owner project registry ----
  function projectStatus(project, active) {
    if (active) return { className: 'badge ok', text: '● เปิดอยู่' };
    const labels = {
      ready: ['badge ok', '● พร้อม'],
      missing: ['badge warn', '⚠ ไม่พบ path'],
      symlinked: ['badge danger', '✕ พบ symbolic link'],
      replaced: ['badge danger', '✕ identity เปลี่ยน'],
      inaccessible: ['badge warn', '⚠ ตรวจสอบไม่ได้'],
      invalid: ['badge danger', '✕ metadata ผิดปกติ'],
      removed: ['badge', '○ นำออกแล้ว'],
    };
    const selected = labels[project.availability] || ['badge warn', `⚠ ${project.availability}`];
    return { className: selected[0], text: selected[1] };
  }

  async function loadProjects(force) {
    if (!state || !state.workspace) return;
    const generation = ++projectsGeneration;
    const context = workspaceContext();
    if (force) cardState('projects', 'loading');
    try {
      const result = await api('projects', undefined, context);
      if (generation !== projectsGeneration || !state || result.workspaceId !== state.workspace.workspaceId || result.workspaceEpoch !== state.workspace.epoch) return;
      renderProjects(result, context);
      cardState('projects', 'ready');
    } catch (error) {
      if (generation !== projectsGeneration) return;
      cardState('projects', 'error', error.message);
    }
  }

  function renderProjects(result, context) {
    const list = $('projects-list');
    list.replaceChildren();
    $('projects-empty').hidden = result.projects.length > 0;
    $('projects-count').hidden = false;
    $('projects-count').textContent = `${result.projects.length} โปรเจกต์`;
    for (const project of result.projects) {
      const active = project.workspaceId === result.activeWorkspaceId && project.root === state.workspace.root;
      const article = document.createElement('article');
      article.className = 'client project-entry';
      const head = document.createElement('div'); head.className = 'client-head';
      const titleWrap = document.createElement('div');
      const name = document.createElement('div'); name.className = 'client-name'; name.textContent = project.displayName;
      const id = document.createElement('code'); id.className = 'client-id'; id.textContent = project.projectId;
      titleWrap.append(name, id);
      const status = document.createElement('span');
      const statusInfo = projectStatus(project, active);
      status.className = statusInfo.className; status.textContent = statusInfo.text;
      head.append(titleWrap, status);

      const root = document.createElement('code'); root.className = 'path project-path'; root.textContent = project.root; root.title = project.root;
      const description = document.createElement('p'); description.className = 'help project-status'; description.textContent = project.statusText;
      const details = document.createElement('details'); details.className = 'details';
      const summary = document.createElement('summary'); summary.textContent = 'รายละเอียด registry';
      const dl = document.createElement('dl'); dl.className = 'dl';
      for (const [label, value] of [['Workspace ID', project.workspaceId], ['Directory identity', `${project.identity.dev}:${project.identity.ino}`], ['อัปเดต', new Date(project.updatedAt).toLocaleString()]]) {
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.textContent = value;
        dl.append(dt, dd);
      }
      details.append(summary, dl);

      const actions = document.createElement('div'); actions.className = 'actions';
      const switchButton = document.createElement('button'); switchButton.type = 'button'; switchButton.className = 'btn small'; switchButton.textContent = active ? 'กำลังเปิดอยู่' : 'เปิดโปรเจกต์นี้';
      switchButton.disabled = active || !project.available || !state.workspace.switchSupported;
      switchButton.addEventListener('click', () => withBusy(switchButton, 'กำลังสลับ…', async () => {
        try {
          const switched = await api('workspace/switch', { path: project.root }, context);
          if (switched.changed) {
            switchedOnce = true;
            notify('success', `สลับไปที่ ${project.displayName} แล้ว — AI ต้องเรียก project_overview ใหม่ และ client ต้องมีสิทธิ์ใน workspace ใหม่`, true);
          }
          await refresh(true);
        } catch (error) {
          notify('error', `เปิดโปรเจกต์ไม่สำเร็จ: ${error.message}${error.data && error.data.recovery ? ` (${error.data.recovery})` : ''}`);
          await refresh(true);
        }
      }));
      const removeButton = document.createElement('button'); removeButton.type = 'button'; removeButton.className = 'btn danger-outline small'; removeButton.textContent = 'นำออกจากรายการ';
      removeButton.addEventListener('click', () => withBusy(removeButton, 'กำลังนำออก…', async () => {
        const warning = active
          ? `${project.displayName} กำลังเปิดอยู่ การนำออกจะลบเฉพาะรายการ registry และไม่หยุด server ไม่ลบไฟล์ ประวัติ trust หรือ client ACL`
          : `นำ ${project.displayName} ออกจาก registry? ไฟล์ ประวัติ trust และ client ACL จะไม่ถูกลบ`;
        if (!(await confirmAction('นำโปรเจกต์ออกจาก registry?', warning, 'นำออกจากรายการ'))) return;
        try {
          await api('projects/remove', { projectId: project.projectId, confirmProjectId: project.projectId }, context);
          notify('success', `นำ ${project.displayName} ออกจาก registry แล้ว โดยไม่ลบไฟล์หรือสิทธิ์เดิม`);
          await loadProjects(true);
        } catch (error) { notify('error', `นำโปรเจกต์ออกไม่สำเร็จ: ${error.message}`); }
      }));
      actions.append(switchButton, removeButton);
      article.append(head, root, description, details, actions);
      list.append(article);
    }
  }

  $('project-add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const pathInput = $('project-add-path');
    const nameInput = $('project-add-name');
    const errorElement = $('project-add-error');
    const projectPath = pathInput.value.trim();
    const displayName = nameInput.value.trim();
    errorElement.hidden = true; pathInput.removeAttribute('aria-invalid');
    if (!projectPath || (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath))) {
      errorElement.textContent = '✕ ต้องกรอก absolute path ของโฟลเดอร์'; errorElement.hidden = false; pathInput.setAttribute('aria-invalid', 'true'); pathInput.focus(); return;
    }
    const context = workspaceContext();
    withBusy($('project-add'), 'กำลังเพิ่ม…', async () => {
      try {
        const body = { path: projectPath };
        if (displayName) body.displayName = displayName;
        const result = await api('projects/add', body, context);
        pathInput.value = ''; nameInput.value = '';
        notify(result.changed ? 'success' : 'info', result.relocated ? `อัปเดต path ของ ${result.project.displayName} แล้ว โดยไม่คัดลอกสิทธิ์ workspace เดิม` : result.changed ? `เพิ่ม ${result.project.displayName} ใน registry แล้ว` : 'โปรเจกต์นี้อยู่ใน registry แล้ว');
        await loadProjects(true);
      } catch (error) {
        errorElement.textContent = `✕ ${error.message}${error.data && error.data.recovery ? ` (${error.data.recovery})` : ''}`;
        errorElement.hidden = false; pathInput.setAttribute('aria-invalid', 'true');
        notify('error', 'เพิ่มโปรเจกต์ไม่สำเร็จ');
      }
    });
  });

  function renderClients(clients, force) {
    const context = workspaceContext();
    const list = $('clients-list');
    const sig = JSON.stringify(clients.map((c) => [c.id, c.name, c.public, c.scopes]));
    if (!force) {
      if (sig === lastClientsSig) return; // nothing changed on the server
      const dirty = [...list.querySelectorAll('input[type="checkbox"]')].some((b) => b.checked !== (b.dataset.orig === '1')) || list.contains(document.activeElement);
      if (dirty) return; // keep unsaved edits; the next save/reload re-syncs
    }
    lastClientsSig = sig;
    list.replaceChildren();
    const count = $('clients-count');
    count.hidden = false;
    count.textContent = `${clients.length} client ในโฟลเดอร์นี้`;
    $('clients-empty').hidden = clients.length > 0;
    const tpl = $('client-template');
    for (const cl of clients) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector('.client-name').textContent = cl.name || '(ไม่มีชื่อ)';
      node.querySelector('.client-id').textContent = cl.id;
      const kind = node.querySelector('.client-kind');
      kind.textContent = cl.public ? 'public · PKCE' : 'confidential';
      if (cl.scopes.length) kind.classList.add('ok');
      const status = node.querySelector('.client-status');
      status.textContent = cl.scopes.length ? `สิทธิ์ปัจจุบัน: ${cl.scopes.join(', ')}` : 'ยังไม่มีสิทธิ์ใน workspace นี้';
      const boxes = [...node.querySelectorAll('input[type="checkbox"]')];
      for (const box of boxes) {
        box.checked = cl.scopes.includes(box.value);
        box.dataset.orig = box.checked ? '1' : '0';
      }
      const saveBtn = node.querySelector('.client-save');
      const revokeBtn = node.querySelector('.client-revoke');
      revokeBtn.disabled = cl.scopes.length === 0;
      saveBtn.addEventListener('click', () => withBusy(saveBtn, 'กำลังบันทึก…', async () => {
        const scopes = boxes.filter((b) => b.checked).map((b) => b.value);
        if (scopes.length === 0) {
          const ok = await confirmAction('ถอนสิทธิ์ทั้งหมด?', `ไม่ได้เลือก scope ใดเลย การบันทึกจะถอนสิทธิ์ของ ${cl.name || cl.id} ใน workspace นี้ทั้งหมด`, 'ถอนสิทธิ์');
          if (!ok) return;
        }
        await saveAccess(cl, scopes, status, context);
      }));
      revokeBtn.addEventListener('click', () => withBusy(revokeBtn, 'กำลังถอน…', async () => {
        const ok = await confirmAction('ถอนสิทธิ์ทั้งหมด?', `${cl.name || cl.id} จะเรียก tool ใน workspace นี้ไม่ได้อีกจนกว่าจะให้สิทธิ์ใหม่ (OAuth login ของ client ยังอยู่)`, 'ถอนสิทธิ์');
        if (!ok) return;
        await saveAccess(cl, [], status, context);
      }));
      list.append(node);
    }
  }

  async function saveAccess(cl, scopes, statusEl, context) {
    try {
      await api('access', { clientId: cl.id, scopes }, context);
      notify('success', scopes.length ? `บันทึกสิทธิ์ของ ${cl.name || cl.id} แล้ว: ${scopes.join(', ')} (มีผลกับคำขอถัดไป)` : `ถอนสิทธิ์ของ ${cl.name || cl.id} ใน workspace นี้แล้ว`);
      await refresh(true);
    } catch (e) {
      statusEl.textContent = `✕ ${e.message}`;
      notify('error', `บันทึกสิทธิ์ไม่สำเร็จ: ${e.message}`);
    }
  }

  // The add picker is separate from the current-root list and loaded on demand.
  let clientPickerGeneration = 0;
  let clientPickerContext = null;
  function resetClientPicker() {
    clientPickerGeneration++;
    clientPickerContext = null;
    $('clients-add').open = false;
    $('client-add-form').reset();
    $('client-add-form').hidden = true;
    $('client-add-select').replaceChildren();
    $('client-add-select').disabled = true;
    $('client-add-status').textContent = '';
  }
  async function loadClientPicker() {
    const generation = ++clientPickerGeneration;
    const context = workspaceContext();
    clientPickerContext = null;
    $('client-add-form').hidden = true;
    $('client-add-select').disabled = true;
    $('client-add-status').textContent = 'กำลังโหลด client ที่เพิ่มได้…';
    try {
      const result = await api('access/available', undefined, context);
      if (generation !== clientPickerGeneration || !state || result.workspaceId !== state.workspace.workspaceId || result.workspaceEpoch !== state.workspace.epoch) return;
      const select = $('client-add-select');
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = 'เลือก client'; select.append(placeholder);
      for (const client of result.clients) {
        const option = document.createElement('option');
        option.value = client.id; option.textContent = `${client.name || '(ไม่มีชื่อ)'} · ${client.id}`;
        select.append(option);
      }
      clientPickerContext = context;
      $('client-add-form').reset();
      select.disabled = result.clients.length === 0;
      $('client-add-form').hidden = result.clients.length === 0;
      $('client-add-status').textContent = result.clients.length ? 'เลือก client และสิทธิ์ แล้วกดบันทึกเพื่ออนุญาต' : 'ไม่มี client อื่นให้เพิ่ม หากยังไม่เคยเชื่อมต่อ ให้ลงทะเบียน client ก่อน';
    } catch (e) {
      if (generation === clientPickerGeneration) $('client-add-status').textContent = `โหลดรายการไม่สำเร็จ: ${e.message}`;
    }
  }
  $('clients-add').addEventListener('toggle', () => {
    if ($('clients-add').open) void loadClientPicker();
    else { clientPickerGeneration++; clientPickerContext = null; }
  });
  $('client-add-reload').addEventListener('click', () => withBusy($('client-add-reload'), 'กำลังโหลด…', loadClientPicker));
  $('client-add-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const context = clientPickerContext;
    const clientId = $('client-add-select').value;
    const scopes = [...$('client-add-form').querySelectorAll('input[name="scope"]:checked')].map((b) => b.value);
    if (!context || !clientId || !scopes.length) { notify('error', 'เลือก client และสิทธิ์อย่างน้อยหนึ่งรายการก่อน'); return; }
    withBusy($('client-add-save'), 'กำลังบันทึก…', async () => {
      try {
        await api('access', { clientId, scopes, addOnly: true }, context);
        resetClientPicker();
        await refresh(true);
        notify('success', 'เพิ่ม client ให้โฟลเดอร์นี้แล้ว');
      } catch (e) { notify('error', `เพิ่ม client ไม่สำเร็จ: ${e.message}`); }
    });
  });

  let clientManagerGeneration = 0;
  let clientManagerContext = null;
  let clientManagerRows = [];
  function updateClientSelection() {
    const boxes = [...$('client-manage-list').querySelectorAll('input[type="checkbox"]')];
    const count = boxes.filter(b => b.checked).length;
    $('client-manage-all').checked = boxes.length > 0 && count === boxes.length;
    $('client-manage-all').indeterminate = count > 0 && count < boxes.length;
    const button = $('client-manage-delete');
    if (!button.hasAttribute('aria-busy')) button.disabled = count === 0;
    button.textContent = count ? `ล้าง client ที่เลือก (${count})` : 'ล้าง client ที่เลือก';
  }
  function resetClientManager() {
    clientManagerGeneration++; clientManagerContext = null; clientManagerRows = [];
    $('clients-manage').open = false;
    $('client-manage-list').replaceChildren();
    $('client-manage-all').disabled = true;
    $('client-manage-status').textContent = '';
    updateClientSelection();
  }
  async function loadClientManager() {
    const generation = ++clientManagerGeneration, context = workspaceContext();
    clientManagerContext = null; clientManagerRows = [];
    $('client-manage-list').replaceChildren(); $('client-manage-all').disabled = true;
    updateClientSelection();
    $('client-manage-status').textContent = 'กำลังโหลดทะเบียน client…';
    try {
      const result = await api('clients/manage', undefined, context);
      if (generation !== clientManagerGeneration || !state || result.workspaceId !== state.workspace.workspaceId || result.workspaceEpoch !== state.workspace.epoch) return;
      clientManagerContext = context; clientManagerRows = result.clients;
      for (const cl of result.clients) {
        const label = document.createElement('label'); label.className = 'check client';
        const box = document.createElement('input'); box.type = 'checkbox'; box.value = cl.id;
        box.addEventListener('change',updateClientSelection);
        const text = document.createElement('span');
        const name = document.createElement('b'); name.textContent = cl.name || '(ไม่มีชื่อ)';
        const id = document.createElement('small'); id.textContent = cl.id;
        const impact = document.createElement('small'); impact.textContent = `มีสิทธิ์ ${cl.workspaceCount} โฟลเดอร์ · ${cl.grantCount} OAuth grant ที่ยังไม่ถอน`;
        text.append(name,id,impact); label.append(box,text); $('client-manage-list').append(label);
      }
      $('client-manage-all').disabled = result.clients.length === 0;
      $('client-manage-status').textContent = result.clients.length ? `${result.clients.length} client ในทะเบียน${result.truncated ? ' (แสดง 100 รายการแรก โหลดใหม่หลังล้างเพื่อดูที่เหลือ)' : ''}` : 'ไม่มี client ในทะเบียน';
      updateClientSelection();
    } catch (e) {
      if (generation === clientManagerGeneration) $('client-manage-status').textContent = `โหลดทะเบียนไม่สำเร็จ: ${e.message}`;
    }
  }
  $('clients-manage').addEventListener('toggle', () => {
    if ($('clients-manage').open) void loadClientManager();
    else { clientManagerGeneration++; clientManagerContext = null; }
  });
  $('client-manage-reload').addEventListener('click', () => withBusy($('client-manage-reload'),'กำลังโหลด…',loadClientManager));
  $('client-manage-all').addEventListener('change', () => {
    for (const box of $('client-manage-list').querySelectorAll('input[type="checkbox"]')) box.checked = $('client-manage-all').checked;
    updateClientSelection();
  });
  $('client-manage-delete').addEventListener('click', async () => {
    const ids = new Set([...$('client-manage-list').querySelectorAll('input:checked')].map(b => b.value));
    const selected = clientManagerRows.filter(c => ids.has(c.id));
    const context = clientManagerContext, generation = clientManagerGeneration;
    if (!context || !selected.length) return;
    await withBusy($('client-manage-delete'),'กำลังล้าง…', async () => {
      const names = selected.map(c => `${c.name || '(ไม่มีชื่อ)'} (${c.id})`).join('\n');
      const confirmed = await confirmAction(`ล้าง ${selected.length} client ที่เลือก?`, `${names}\n\nลบทะเบียนและถอน token/สิทธิ์ในทุกโฟลเดอร์ของ client เหล่านี้ ต้องลงทะเบียนและเชื่อมใหม่หากต้องการใช้อีก การเชื่อมต่ออื่นและไฟล์โปรเจกต์ไม่ถูกลบ`, 'ลบทะเบียนที่เลือก');
      if (!confirmed) return;
      if (generation !== clientManagerGeneration) { notify('error','รายการเปลี่ยนแล้ว กรุณาโหลดและเลือกใหม่'); return; }
      try {
        await api('clients/delete',{clients:selected.map(c => ({id:c.id,reviewHash:c.reviewHash})),confirm:'delete-selected-clients'},context);
        resetClientPicker();
        await refresh(true);
        if (generation === clientManagerGeneration && $('clients-manage').open) await loadClientManager();
        notify('success',`ล้าง ${selected.length} client แล้ว การเชื่อมต่อที่ลบใช้ token เดิมไม่ได้อีก`);
      } catch (e) { notify('error',`ล้าง client ไม่สำเร็จ: ${e.message}`); }
    });
    updateClientSelection();
  });

  let scheduleSignature = '';
  function renderSchedules(s) {
    const signature = JSON.stringify([s.workspace.workspaceId,s.workspace.epoch,s.schedules]);
    if (signature === scheduleSignature) return;
    scheduleSignature = signature;
    const context = {'x-dodo-workspace':s.workspace.workspaceId, 'x-dodo-epoch':s.workspace.epoch};
    const text = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
    const action = (box, label, run) => {
      const b = text('button',label); b.className = 'btn primary'; b.type = 'button';
      b.addEventListener('click', () => withBusy(b,'กำลังบันทึก…', async () => {
        try { await run(); await refresh(true); notify('success','บันทึกการอนุญาตแล้ว'); }
        catch (e) { notify('error',e.message); }
      })); box.append(b);
    };
    const schedules = $('schedules-list'); schedules.replaceChildren();
    for (const job of s.schedules || []) {
      const box = document.createElement('article'); box.className='client';
      box.append(text('h3',job.spec.name + ' · ' + job.status),text('p','โปรเจกต์: ' + job.root),text('pre',job.spec.command));
      box.append(text('p','โฟลเดอร์ทำงาน: ' + job.spec.cwd),text('p','ตาราง: ' + job.spec.cron + ' · ' + job.spec.timezone));
      box.append(text('p','หมดอายุ: ' + new Date(job.spec.expiresAt).toLocaleString() + ' · จำกัดเวลารัน ' + Math.round(job.spec.timeoutMs/1000) + ' วินาที'));
      box.append(text('p','OS sandbox: ' + (job.spec.sandbox ? 'ต้องเปิด' : 'ไม่ใช้') + ' · Network: ' + (job.spec.network ? 'อนุญาต' : 'ปิดใน sandbox')));
      const details = document.createElement('details'); details.append(text('summary','รหัสรายการและ hash ที่อนุมัติ'),text('code',job.id + ' ' + job.digest)); box.append(details);
      box.append(text('p','คำสั่งใช้โค้ดปัจจุบันในโปรเจกต์ อาจรันโค้ดใด ๆ ตามสิทธิ์ OS ไม่ได้ตรึง revision'));
      if (job.status === 'pending') {
        const label = document.createElement('label'); const checked = document.createElement('input'); checked.type='checkbox';
        label.append(checked,document.createTextNode('อนุญาตคำสั่งนี้ตามตาราง แม้ไม่ได้เปิดแชต')); box.append(label);
        action(box,'อนุมัติงานตั้งเวลา',() => { if (!checked.checked) throw new Error('กรุณายืนยันการทำงานตามตารางก่อน'); return api('schedule/approve',{id:job.id,digest:job.digest},context); });
      }
      if (job.status === 'approved' || job.status === 'pending' || job.status === 'paused') action(box,'ยกเลิกงานนี้',() => api('schedule/revoke',{id:job.id},context));
      schedules.append(box);
    }
    if (!(s.schedules || []).length) schedules.append(text('p','ยังไม่มีงานตั้งเวลา'));
  }

  // ---- refresh ----
  let refreshing = null;
  async function refresh(force) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const s = await api('state');
        $('card-auth').hidden = true;
        render(s, force === true);
        renderSchedules(s);
      } catch (e) {
        if (e.status === 401) {
          $('card-auth').hidden = false;
          for (const p of ['ws', 'projects', 'perm', 'conn', 'clients']) cardState(p, 'error', 'ต้องเปิดจากลิงก์ส่วนตัวใน terminal');
          setChip('chip-config', 'error', '✕', 'ไม่มี token หรือหมดอายุ');
        } else {
          for (const p of ['ws', 'projects', 'perm', 'conn', 'clients']) cardState(p, 'error', e.message);
          setChip('chip-mcp', 'error', '✕', 'ติดต่อไม่ได้');
        }
        document.getElementById('main').setAttribute('aria-busy', 'false');
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  // ---- workspace switch ----
  $('ws-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('ws-path');
    const errEl = $('ws-path-error');
    const value = input.value.trim();
    errEl.hidden = true; input.removeAttribute('aria-invalid');
    if (!value) { errEl.textContent = 'กรอก absolute path ของโฟลเดอร์โปรเจกต์'; errEl.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) { errEl.textContent = 'ต้องเป็น absolute path (ขึ้นต้นด้วย /)'; errEl.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    if (state && state.workspace && value === state.workspace.root) { notify('info', 'โปรเจกต์นี้เปิดอยู่แล้ว'); return; }
    withBusy($('ws-switch'), 'กำลังสลับ…', async () => {
      $('ws-progress').hidden = false;
      input.disabled = true;
      try {
        const r = await api('workspace/switch', { path: value });
        if (r.changed) {
          switchedOnce = true;
          notify('success', `สลับไปที่ ${r.root} แล้ว — workspace ID ${r.workspaceId}, epoch ${r.epoch} AI ต้องเรียก project_overview ใหม่ และตรวจสิทธิ์ client ด้านล่างสำหรับ path นี้`, true);
          input.value = '';
        } else {
          notify('info', 'โปรเจกต์นี้เปิดอยู่แล้ว ไม่มีการเปลี่ยนแปลง');
        }
        await refresh(true);
      } catch (e) {
        let text = e.message;
        if (e.status === 409 && /job/i.test(text)) text = `${text} — หยุดหรือรอให้งานเสร็จก่อน แล้วลองใหม่`;
        else if (e.status === 409 && /in flight/i.test(text)) text = `${text} — มีคำขอ MCP ค้างอยู่ ลองใหม่อีกครั้งในไม่กี่วินาที`;
        else if (e.status === 409) text = `${text}`;
        else if (e.status === 400) text = `${text}`;
        errEl.textContent = `✕ ${text}${e.data && e.data.recovery ? ` (${e.data.recovery})` : ''}`;
        errEl.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        notify('error', 'สลับ workspace ไม่สำเร็จ — โปรเจกต์เดิมยังใช้งานได้ตามปกติ');
        await refresh(true);
      } finally {
        $('ws-progress').hidden = true;
        input.disabled = !(state && state.workspace && state.workspace.switchSupported);
      }
    });
  });
  $('ws-copy').addEventListener('click', (ev) => copyText(state && state.workspace ? state.workspace.root : '', ev.currentTarget));

  $('desktop-command-copy').addEventListener('click', (ev) => copyText($('desktop-command').textContent, ev.currentTarget));

  $('desktop-disable').addEventListener('click', () => {
    withBusy($('desktop-disable'), 'กำลังหยุด…', async () => {
      try { await api('desktop/disable', {}); await refresh(true); notify('success', 'ปิด Desktop access แล้ว'); }
      catch (e) { notify('error', `ปิด Desktop access ไม่สำเร็จ: ${e.message}`); }
    }).finally(() => { $('desktop-disable').disabled = !state || !state.desktop || state.desktop.policy.mode === 'off'; });
  });

  // ---- permissions ----
  $('perm-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const context = workspaceContext();
    const mode = (new FormData(ev.currentTarget).get('mode') || '').toString();
    if (!MODE_LABEL[mode]) { notify('error', 'เลือกระดับสิทธิ์ก่อน'); return; }
    withBusy($('perm-save'), 'กำลังบันทึก…', async () => {
      try {
        if (mode === 'trusted') {
          const ok = await confirmAction('บันทึกเป็น trusted?', 'AI จะแก้ไฟล์และรันคำสั่งใน workspace นี้ได้โดยไม่ถาม คำสั่งรันด้วยสิทธิ์ OS ของบัญชีคุณ (เว้นแต่เปิด command sandbox) ต้องการบันทึกหรือไม่', 'บันทึก trusted');
          if (!ok) {
            // Put the radio back on the saved value so the form never shows an unsaved trusted selection.
            const back = document.querySelector(`#perm-form input[value="${(state && state.permissions && state.permissions.savedMode) || 'inspect'}"]`);
            if (back) back.checked = true;
            return;
          }
        }
        const r = await api('config', { mode }, context);
        const overridden = state && state.permissions && state.permissions.override;
        notify(overridden ? 'info' : 'success', overridden
          ? `บันทึกค่า ${mode} แล้ว แต่รอบนี้ยังมีผลเป็น ${r.effectiveMode || 'trusted'} จาก ${overridden === 'bypass' ? '--bypass' : '--allow --all'} จนกว่าจะ restart โดยไม่ใช้ flag`
          : `บันทึกสิทธิ์ ${mode} แล้ว มีผลกับคำขอถัดไป`);
        await refresh(true);
      } catch (e) { notify('error', `บันทึกสิทธิ์ไม่สำเร็จ: ${e.message}`); }
    });
  });

  // ---- connection ----
  $('conn-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('conn-origin');
    const errEl = $('conn-origin-error');
    const value = input.value.trim();
    errEl.hidden = true; input.removeAttribute('aria-invalid');
    let parsed = null;
    try { parsed = new URL(value); } catch (_e) { parsed = null; }
    const loopback = parsed && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if (!parsed || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username) {
      errEl.textContent = '✕ ต้องเป็น origin แบบ https://host (ไม่มี path, query หรือ user) http:// ใช้ได้เฉพาะ 127.0.0.1/localhost สำหรับทดสอบ';
      errEl.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return;
    }
    withBusy($('conn-save'), 'กำลังบันทึก…', async () => {
      try {
        const r = await api('config', { publicUrl: parsed.origin });
        notify(r.restartRequired ? 'info' : 'success', r.restartRequired ? `บันทึก ${parsed.origin} แล้ว — restart DODO เพื่อให้ OAuth issuer และ /mcp ใช้ origin ใหม่` : 'บันทึกแล้ว');
        await refresh(true);
      } catch (e) {
        errEl.textContent = `✕ ${e.message}`; errEl.hidden = false; input.setAttribute('aria-invalid', 'true');
        notify('error', `บันทึก origin ไม่สำเร็จ: ${e.message}`);
      }
    });
  });
  $('conn-local-copy').addEventListener('click', (ev) => copyText(state && state.connection ? state.connection.mcpLocalUrl : '', ev.currentTarget));
  $('conn-public-copy').addEventListener('click', (ev) => {
    const c = state && state.connection;
    copyText(c ? (c.mcpPublicUrl || (c.publicUrl ? `${c.publicUrl}/mcp` : '')) : '', ev.currentTarget);
  });

  // ---- misc ----
  $('refresh').addEventListener('click', (ev) => withBusy(ev.currentTarget, '⟳ …', () => refresh(true)));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'r' && (ev.metaKey || ev.ctrlKey) && ev.shiftKey) { ev.preventDefault(); refresh(true); }
  });
  setInterval(() => { if (!document.hidden && !document.querySelector('.btn[aria-busy="true"]')) refresh(false); }, 30000);

  if (!token) {
    $('card-auth').hidden = false;
    for (const p of ['ws', 'projects', 'perm', 'conn', 'clients']) cardState(p, 'error', 'ต้องเปิดจากลิงก์ส่วนตัวใน terminal');
    setChip('chip-config', 'error', '✕', 'ไม่มี token');
    document.getElementById('main').setAttribute('aria-busy', 'false');
  } else {
    refresh(true);
  }
})();
