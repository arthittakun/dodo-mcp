import { staticResponse } from './byteRange.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { DodoError } from '../../errors.js';
import { buildChildEnv } from '../../security/env.js';
import { redact } from '../../security/redact.js';
import { sandboxWrapperFromConfig } from '../jobs/sandboxWiring.js';
import { digestOf, newId } from '../../util/hash.js';
import { MediaStorage, actorKey, type Actor } from './storage.js';
import { BrowserObservation, type BrowserObservationData, type BrowserActionInput, type GameActionInput } from './contracts.js';
import { publicRequest, validatePublicUrl } from './network.js';

const WORKSPACE_ORIGIN = 'https://dodo-workspace.invalid';
const State = BrowserObservation.pick({ title: true, text: true, elements: true, truncated: true, media: true });
/** Fixed code, not caller-provided JS. No input values/passwords are read. */
const STATE_SCRIPT = `(() => {
  function selector(el) {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = []; let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 12; depth++, node = node.parentElement) {
      const name = node.tagName.toLowerCase(); let index = 1;
      for (let p = node.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === node.tagName) index++;
      parts.unshift(name + ':nth-of-type(' + index + ')');
      if (name === 'html') break;
    }
    return parts.join(' > ');
  }
  const all = Array.from(document.querySelectorAll('button,a,input,textarea,select,[role],video,audio')).filter(el => {
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  });
  const text = (document.body && document.body.innerText) || '';
  return { title: document.title.slice(0,300), text: text.slice(0,10000), truncated: text.length > 10000 || all.length > 100,
    media: Array.from(document.querySelectorAll('video,audio')).slice(0,8).map(el=>({selector:selector(el),currentTime:Number.isFinite(el.currentTime)?el.currentTime:0,duration:Number.isFinite(el.duration)?el.duration:null,paused:el.paused,readyState:el.readyState,errorCode:el.error?el.error.code:null})),
    elements: all.slice(0,100).map(el => ({ selector: selector(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
      name: (el.getAttribute('aria-label') || el.getAttribute('title') || (el.labels && Array.from(el.labels).map(x => x.innerText).join(' ')) || (['INPUT','TEXTAREA','SELECT'].includes(el.tagName) ? '' : el.innerText) || '').slice(0,200), disabled: !!el.disabled, type: el.getAttribute('type') || '' })) };
})()`;
interface ControlledMedia {
  tagName: string; currentTime: number; duration: number; readyState: number;
  error: { code: number } | null; muted: boolean;
  play(): Promise<void>; pause(): void; load(): void;
  addEventListener(name: string, listener: () => void, options?: { once: boolean }): void;
  removeEventListener(name: string, listener: () => void): void;
}
interface Session {
  id: string; owner: string; check: () => void; browser: Browser; context: BrowserContext; page: Page; mode: 'workspace' | 'public'; origins: Set<string>;
  expiresAt: number; busy: boolean; console: string[]; network: string[]; launcherDirectory?: string;
  current?: { id: string; hash: string; url: string; expiresAt: number; data: BrowserObservationData };
}
export class BrowserService {
  private readonly sessions = new Map<string, Session>();
  private opening = 0;
  constructor(private readonly storage: MediaStorage) {}
  private ownOrigin(): string | undefined { try { return this.storage.services.config.publicUrl ? new URL(this.storage.services.config.publicUrl).origin : undefined; } catch { return undefined; } }
  private session(actor: Actor, id: string): Session {
    this.storage.check(); const session = this.sessions.get(id);
    if (!session || session.owner !== actorKey(actor) || session.expiresAt <= Date.now()) throw new DodoError('NOT_FOUND', 'unknown/expired browser session for this client');
    session.check();
    if (session.mode === 'public' && !this.storage.services.config.allowWebFetch) throw new DodoError('FORBIDDEN', 'outbound web access is disabled by owner configuration');
    return session;
  }
  private async bounded<T>(session: Session, op: Promise<T>, ms = 8000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([op, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { void session.browser.close().catch(() => undefined); reject(new DodoError('TIMEOUT', 'browser operation deadline exceeded; session closed')); }, ms); })]); }
    finally { clearTimeout(timer); }
  }
  private async exclusive<T>(actor: Actor, id: string, fn: (s: Session) => Promise<T>): Promise<T> {
    const s = this.session(actor, id); if (s.busy) throw new DodoError('RESOURCE_LIMIT', 'browser session is busy'); s.busy = true;
    try { return await fn(s); } finally { s.busy = false; }
  }
  private safeUrl(raw: string): string { try { const u = new URL(raw); return `${u.origin}${u.pathname}`.slice(0, 1000); } catch { return '(invalid url)'; } }
  private fingerprint(state: { title: string; text: string; elements: unknown; truncated: boolean; url: string }): string {
    // Playback time/readiness change independently of DOM identity, even while paused/loading.
    return digestOf({ title: state.title, text: state.text, elements: state.elements, truncated: state.truncated, url: state.url });
  }
  private async state(s: Session) { const state = State.parse(await this.bounded(s, s.page.evaluate(STATE_SCRIPT))); return { ...state, url: s.page.url() }; }
  async open(actor: Actor, opts: { mode: 'workspace' | 'public'; path?: string | undefined; url?: string | undefined; origins: string[] }, check: () => void) {
    this.storage.check(); check(); if (this.sessions.size + this.opening >= 3) throw new DodoError('RESOURCE_LIMIT', 'at most three isolated browser sessions');
    let target: string; const origins = new Set<string>();
    if (opts.mode === 'workspace') {
      if (!opts.path || opts.url || opts.origins.length) throw new DodoError('INVALID_INPUT', 'workspace mode takes a local HTML path only');
      const p = this.storage.services.wfs.resolve(opts.path); this.storage.services.wfs.assertRegularFileForDirectAccess(p);
      if (!/\.html?$/i.test(p.rel)) throw new DodoError('INVALID_INPUT', 'workspace browser entry must be HTML');
      target = `${WORKSPACE_ORIGIN}/${p.rel.split('/').map(encodeURIComponent).join('/')}`;
    } else {
      if (!this.storage.services.config.allowWebFetch) throw new DodoError('FORBIDDEN', 'public browser requires the EXISTING allowWebFetch owner setting; no setting was changed');
      if (!opts.url || opts.path) throw new DodoError('INVALID_INPUT', 'public mode takes a URL, not a filesystem path');
      for (const value of [...opts.origins, new URL(opts.url).origin]) { const u = new URL(value); if (u.pathname !== '/' || u.search || u.hash) throw new DodoError('INVALID_INPUT', 'origins must be exact origins'); origins.add(u.origin); }
      target = validatePublicUrl(opts.url, origins, this.ownOrigin()).href;
    }
    this.opening++; let browser: Browser | undefined, launcherDirectory: string | undefined;
    try {
      const { chromium } = await import('playwright'); let executablePath = chromium.executablePath();
      if (!fs.existsSync(executablePath)) throw new DodoError('NOT_SUPPORTED', 'Playwright Chromium is not installed; run npx playwright install chromium in this DODO installation');
      // commandSandbox is the run_command/run_commands policy. The POSIX
      // launcher wrapper is useful on macOS/Linux, but is not a valid Windows
      // executablePath. Windows Chromium keeps Playwright's own browser sandbox
      // and DODO's request/network guards; command jobs use the native SRT sandbox.
      const wrapped = process.platform === 'win32' ? undefined : sandboxWrapperFromConfig(this.storage.services.config, this.storage.services.wfs.root)(executablePath, [], { allowNetwork: opts.mode === 'public', requested: undefined });
      if (wrapped) {
        launcherDirectory = this.storage.directory(); const launcher = path.join(launcherDirectory, 'browser-launcher');
        const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
        fs.writeFileSync(launcher, `#!/bin/sh\nexec ${quote(wrapped.program)} ${wrapped.args.map(quote).join(' ')} "$@"\n`, { flag: 'wx', mode: 0o700 }); executablePath = launcher;
      }
      browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: true, timeout: 15000, env: buildChildEnv({ parentEnv: process.env, workspaceRoot: this.storage.services.wfs.root, extraAllowlist: [] }) as Record<string, string>, args: ['--disable-background-networking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
      // Defense in depth, not a replacement for the existing OS sandbox or browser sandbox.
      await context.addInitScript(`for (const name of ['RTCPeerConnection','webkitRTCPeerConnection','WebSocket','Worker','SharedWorker']) { try { Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false}); } catch {} }`);
      await context.routeWebSocket('**/*', socket => socket.close());
      const page = await context.newPage(); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
      const session: Session = { id: newId('browser'), owner: actorKey(actor), check, browser, context, page, mode: opts.mode, origins, expiresAt: Date.now() + 900000, busy: false, console: [], network: [], ...(launcherDirectory ? { launcherDirectory } : {}) };
      context.on('page', p => { if (p !== page) void p.close().catch(() => undefined); });
      page.on('dialog', d => { void d.dismiss().catch(() => undefined); }); page.on('download', d => { void d.cancel().catch(() => undefined); });
      page.on('console', message => { session.console.push(redact(message.text()).slice(0, 300)); if (session.console.length > 30) session.console.shift(); });
      page.on('pageerror', err => { session.console.push(redact(err.message).slice(0, 300)); if (session.console.length > 30) session.console.shift(); });
      await context.route('**/*', async route => {
        const request = route.request();
        try {
          this.storage.check(); session.check(); if (session.expiresAt <= Date.now()) throw new Error('session expired');
          const url = new URL(request.url());
          if (session.mode === 'workspace') {
            if (url.origin !== WORKSPACE_ORIGIN || request.method() !== 'GET') throw new Error('offline browser blocks network and mutation requests');
            const file = decodeURIComponent(url.pathname.replace(/^\//, ''));
            const input = this.storage.services.wfs.readFileBytes(file, Math.min(this.storage.services.limits.readFileBytes, 8 * 1024 * 1024));
            const ext = path.extname(input.rel).toLowerCase();
            const type: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.wav': 'audio/wav' };
            if (!type[ext]) throw new Error('unsupported static resource type');
            const response = staticResponse(input.bytes, type[ext], request.headers()['range']);
            session.check();
            await route.fulfill(response);
          } else {
            if (!this.storage.services.config.allowWebFetch) throw new Error('web access disabled');
            const response = await publicRequest(request.url(), { origins: session.origins, ownOrigin: this.ownOrigin(), method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer() });
            this.storage.check(); session.check();
            await route.fulfill(response);
          }
          session.network.push(`${request.method()} ${this.safeUrl(request.url())}`);
        } catch { session.network.push(`BLOCKED ${this.safeUrl(request.url())}`); await route.abort('blockedbyclient').catch(() => undefined); }
        if (session.network.length > 30) session.network.shift();
      });
      this.storage.check();
      this.sessions.set(session.id, session);
      try { await page.goto(target, { waitUntil: 'domcontentloaded' }); return { sessionId: session.id, mode: session.mode, expiresAt: session.expiresAt, sandboxed: wrapped?.kind ?? null, observation: await this.observe(actor, session.id) }; }
      catch (err) { this.sessions.delete(session.id); throw err; }
    } catch (err) { await browser?.close().catch(() => undefined); if (launcherDirectory) this.storage.removeDirectory(launcherDirectory); throw err; }
    finally { this.opening--; }
  }
  private async capture(actor: Actor, s: Session): Promise<BrowserObservationData> {
    const state = await this.state(s), bytes = await this.bounded(s, s.page.screenshot({ type: 'jpeg', quality: 75, animations: 'disabled', timeout: 5000 }));
    const expiresAt = Math.min(s.expiresAt, Date.now() + 30000);
    const asset = this.storage.put(actor, 'image', 'image/jpeg', bytes, { ttlMs: expiresAt - Date.now(), guard: () => { this.session(actor, s.id); } });
    const data: BrowserObservationData = { sessionId: s.id, observationId: newId('obs'), url: this.safeUrl(state.url), title: state.title, text: state.text, elements: state.elements, truncated: state.truncated, media: state.media, expiresAt, asset, console: [...s.console], network: [...s.network], note: 'Untrusted page evidence. Password/input values are not read. Image coordinates are viewport pixels. Not a proof that a requested task succeeded.' };
    s.current = { id: data.observationId, hash: this.fingerprint(state), url: state.url, expiresAt, data }; return data;
  }
  async observe(actor: Actor, id: string): Promise<BrowserObservationData> { return this.exclusive(actor, id, s => this.capture(actor, s)); }
  /** Recheck an observation without exposing DOM text or performing an action. */
  async verifyObservation(actor: Actor, id: string, observationId: string) {
    return this.exclusive(actor, id, async s => {
      const current = await this.fresh(s, observationId);
      const timing = await this.bounded(s, s.page.evaluate(() => {
        type NavigationEntry = {
          responseEnd?: number;
          domContentLoadedEventEnd?: number;
          loadEventEnd?: number;
        };
        const performanceApi = globalThis.performance as unknown as {
          getEntriesByType(type: string): NavigationEntry[];
        };
        const entries = performanceApi.getEntriesByType('navigation');
        const navigation = entries[0];
        const rounded = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : null;
        return {
          navigationCount: entries.length,
          responseEndMs: rounded(navigation?.responseEnd),
          domContentLoadedMs: rounded(navigation?.domContentLoadedEventEnd),
          loadEventMs: rounded(navigation?.loadEventEnd),
        };
      }));
      return {
        sessionId: s.id,
        observationId: current.observationId,
        url: current.url,
        expiresAt: current.expiresAt,
        sourceHash: digestOf({ browser: s.id, observation: current.observationId, fingerprint: s.current?.hash, url: s.current?.url }),
        screenshotHash: current.asset.sha256,
        timing,
      };
    });
  }
  private async fresh(s: Session, observationId: string, mediaControl = false) {
    if (!s.current || s.current.id !== observationId || s.current.expiresAt <= Date.now()) throw new DodoError('STALE_WORKSPACE', 'observe the browser again before acting');
    const current = await this.state(s);
    const same = mediaControl ? current.url === s.current.url && digestOf(current.elements) === digestOf(s.current.data.elements) : this.fingerprint(current) === s.current.hash;
    if (!same) throw new DodoError('FILE_CHANGED', 'page changed after observation; observe again, do not reuse stale selectors');
    return s.current.data;
  }
  async action(actor: Actor, id: string, observationId: string, action: BrowserActionInput, check: () => void) {
    return this.exclusive(actor, id, async s => {
      const observation = await this.fresh(s, observationId, action.kind === 'media'); check();
      if ('selector' in action) {
        if (!observation.elements.some(e => e.selector === action.selector)) throw new DodoError('INVALID_INPUT', 'use an exact selector returned by browser_observe');
        if (await s.page.locator(action.selector).count() !== 1) throw new DodoError('AMBIGUOUS_EDIT', 'selector is not unique');
      }
      if (action.kind === 'navigate') {
        const destination = new URL(action.url, s.page.url());
        if (s.mode === 'workspace' ? destination.origin !== WORKSPACE_ORIGIN : !s.origins.has(destination.origin)) throw new DodoError('FORBIDDEN', 'navigation outside this session origins');
      }
      delete s.current;
      try {
        switch (action.kind) {
          case 'click': await s.page.locator(action.selector).click(); break;
          case 'fill': await s.page.locator(action.selector).fill(action.text); break;
          case 'press': await s.page.locator(action.selector).press(action.key); break;
          case 'select': await s.page.locator(action.selector).selectOption(action.value); break;
          case 'scroll': await s.page.mouse.wheel(0, action.deltaY); break;
          case 'navigate': await s.page.goto(new URL(action.url, s.page.url()).href, { waitUntil: 'domcontentloaded' }); break;
          case 'media': await this.bounded(s, s.page.locator(action.selector).evaluate(async (node, input) => {
            // Playwright must receive a function, not a function-shaped string (which is only evaluated, never invoked).
            const element = node as unknown as ControlledMedia;
            if (!['VIDEO', 'AUDIO'].includes(element.tagName) || typeof element.play !== 'function') throw Error('not a media element');
            const event = (name: string, perform?: () => void) => new Promise<void>((resolve,reject) => {
              const done=()=>{clearTimeout(timer);element.removeEventListener(name,ok);element.removeEventListener('error',bad);};
              const ok=()=>{done();resolve();}; const bad=()=>{done();reject(Error('media decoder error'));};
              const timer=setTimeout(()=>{done();reject(Error('media event timed out: '+name));},5000);
              element.addEventListener(name,ok,{once:true});element.addEventListener('error',bad,{once:true});
              if(perform)perform();
            });
            if (element.error) throw Error('media unavailable or unsupported codec');
            if (input.control === 'pause') { element.pause(); return; }
            if (input.control === 'mute') { element.muted=true; return; }
            if (element.readyState < 1) await event('loadedmetadata',()=>element.load());
            if (input.control === 'play') return element.play();
            if (input.control === 'seek') {
              if (typeof input.timeSec !== 'number' || (Number.isFinite(element.duration) && input.timeSec > element.duration)) throw Error('seek is outside media duration');
              const time = input.timeSec;
              if (Math.abs(element.currentTime-time)>0.01) await event('seeked',()=>{element.currentTime=time;});
            }
          }, action)); break;
        }
        check(); await new Promise(resolve => setTimeout(resolve, 100));
        return { posted: true, observation: await this.capture(actor, s), note: 'Action was dispatched; verify the after-state before claiming success.' };
      } catch (err) { throw new DodoError('RECOVERY_REQUIRED', `browser action may have happened; inspect the page before any retry (${err instanceof DodoError ? err.code : 'BROWSER_ERROR'})`); }
    });
  }
  async gameStep(actor: Actor, id: string, observationId: string, action: GameActionInput, check: () => void) {
    return this.exclusive(actor, id, async s => {
      await this.fresh(s, observationId); check(); delete s.current;
      try {
        if (action.kind === 'wait') await new Promise(resolve => setTimeout(resolve, action.durationMs));
        else if (action.kind === 'click') { if (action.x >= 1280 || action.y >= 720) throw new Error('outside viewport'); await s.page.mouse.click(action.x, action.y); }
        else {
          const pressed: string[] = [];
          try { for (const key of [...new Set(action.keys)]) { check(); await s.page.keyboard.down(key); pressed.push(key); } if (action.holdMs) await new Promise(resolve => setTimeout(resolve, action.holdMs)); }
          finally { for (const key of pressed.reverse()) await s.page.keyboard.up(key).catch(() => undefined); }
        }
        check(); await new Promise(resolve => setTimeout(resolve, 80)); return this.capture(actor, s);
      } catch { throw new DodoError('RECOVERY_REQUIRED', 'game input outcome uncertain; held browser keys were released, observe before any retry'); }
    });
  }
  info(actor: Actor, id: string) { const s = this.session(actor, id); return { sessionId: s.id, mode: s.mode, expiresAt: s.expiresAt, url: this.safeUrl(s.page.url()) }; }
  async closeSession(actor: Actor, id: string) { const s = this.session(actor, id); this.sessions.delete(id); await s.browser.close(); if (s.launcherDirectory) this.storage.removeDirectory(s.launcherDirectory); return { closed: true, sessionId: id }; }
  async sweep(): Promise<void> {
    for (const [id, session] of this.sessions) {
      let expired = session.expiresAt <= Date.now();
      try { session.check(); } catch { expired = true; }
      if (expired) { this.sessions.delete(id); await session.browser.close().catch(() => undefined); if (session.launcherDirectory) this.storage.removeDirectory(session.launcherDirectory); }
    }
  }
  async close() { const sessions = [...this.sessions.values()]; this.sessions.clear(); await Promise.all(sessions.map(async s => { await s.browser.close().catch(() => undefined); if (s.launcherDirectory) this.storage.removeDirectory(s.launcherDirectory); })); }
}
