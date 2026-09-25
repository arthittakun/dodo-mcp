import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { DodoError } from '../errors.js';
import type { LocalConfigServer } from './localConfig.js';
import type { ConfigSession } from './configSession.js';

const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const COOKIE_NAME = '__Secure-dodo_remote_config';
const REMOTE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PAIR_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export interface RemoteConfigLease {
  url: string;
  pairingCode: string;
  expiresAt: number;
}

export interface RemoteConfigStatus {
  active: boolean;
  paired: boolean;
  url: string;
  expiresAt: number | null;
}

type LocalConfigTarget = Pick<LocalConfigServer, 'origin' | 'createRemoteSession'>;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function sameDigest(expected: Buffer | undefined, value: string): boolean {
  if (!expected) return false;
  const actual = digest(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function pairingCode(): string {
  const bytes = randomBytes(16);
  const chars = [...bytes].map(byte => PAIR_ALPHABET[byte & 31]).join('');
  return chars.match(/.{1,4}/g)?.join('-') ?? chars;
}

function cookie(req: Request, name: string): string {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const item = part.trim();
    if (!item.startsWith(`${name}=`)) continue;
    const value = item.slice(name.length + 1);
    if (/^[A-Za-z0-9_-]{20,200}$/.test(value)) return value;
  }
  return '';
}

function securityHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', REMOTE_CSP);
}

function safeHeader(req: Request, name: string, max: number): string | undefined {
  const value = req.headers[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n]/.test(value)) return undefined;
  return value;
}

const LOGIN_HTML = Buffer.from(`<!doctype html>
<html lang="th" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer"><title>DODO Remote Config</title><link rel="stylesheet" href="/config/login.css"></head><body><main><section><div class="logo" aria-hidden="true">DD</div><h1>DODO Remote Config</h1><p>หน้าเจ้าของเครื่องแบบชั่วคราว กรุณากรอก pairing code ที่แสดงใน terminal ของ DODO</p><form id="pair" novalidate><label for="code">Pairing code</label><input id="code" name="code" type="text" autocomplete="one-time-code" spellcheck="false" maxlength="32" required autofocus><button type="submit">เชื่อมต่อ</button><p id="status" role="alert" aria-live="polite"></p></form><p class="note">Code ใช้ได้ครั้งเดียว หน้า Config จะปิดภายใน 1 ชั่วโมง เปิดใหม่ด้วย dodo --web ได้โดยไม่ต้อง restart และไม่ผูกกับลิงก์ Local Config 8 ชั่วโมง</p></section></main><script src="/config/login.js"></script></body></html>`);
const LOGIN_CSS = Buffer.from(`:root{color-scheme:dark;background:#0f141b;color:#e8edf4;font:16px/1.6 system-ui,-apple-system,"Noto Sans Thai",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:min(100%,480px)}section{background:#171e28;border:1px solid #303a48;border-radius:14px;padding:28px;box-shadow:0 18px 45px #0005}.logo{display:grid;place-items:center;width:48px;height:48px;border-radius:10px;background:#2c78c8;color:white;font-weight:800}h1{margin:18px 0 4px;font-size:1.55rem}p{color:#b7c1ce}label{display:block;margin:20px 0 7px;font-weight:700}input,button{width:100%;min-height:46px;border-radius:9px;font:inherit}input{border:1px solid #526074;background:#0e141c;color:#fff;padding:10px 12px;text-transform:uppercase;letter-spacing:.08em}input:focus{outline:3px solid #4c9cff55;border-color:#65aaff}button{margin-top:12px;border:0;background:#2877c7;color:white;font-weight:750;cursor:pointer}button:disabled{opacity:.6;cursor:wait}#status{min-height:1.6em;color:#ff9e9e}.note{font-size:.9rem;color:#93a0b1}@media(prefers-color-scheme:light){:root{background:#eef2f7;color:#17202b}section{background:#fff;border-color:#ccd5e1;box-shadow:0 18px 45px #34405422}p{color:#566274}input{background:#fff;color:#17202b;border-color:#8794a6}.note{color:#657286}}`);
const LOGIN_JS = Buffer.from(`'use strict';(()=>{const form=document.getElementById('pair'),input=document.getElementById('code'),status=document.getElementById('status'),button=form.querySelector('button');form.addEventListener('submit',async event=>{event.preventDefault();if(button.disabled)return;status.textContent='';button.disabled=true;button.textContent='กำลังตรวจ…';try{const response=await fetch('/config/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:input.value}),credentials:'same-origin',cache:'no-store'});let result={};try{result=await response.json()}catch{}if(!response.ok)throw new Error(result.error||('HTTP '+response.status));input.value='';location.replace('/config');}catch(error){input.value='';status.textContent='✕ '+error.message;input.focus();}finally{button.disabled=false;button.textContent='เชื่อมต่อ';}});})();`);

/**
 * A process-only, one-hour bridge from the public listener to the existing
 * loopback Local Config server. It grants no authority itself: after a
 * one-time pairing exchange every request is re-authenticated here and then
 * forwarded through a separate, revocable one-hour owner capability and
 * Local Config's original policy routes. The local browser token is untouched.
 */
export class RemoteConfigGateway {
  private target: LocalConfigTarget | undefined;
  private ownerSession: ConfigSession | undefined;
  private pairingHash: Buffer | undefined;
  private pairingExpiresAt = 0;
  private sessionHash: Buffer | undefined;
  private expiresAt = 0;
  private attempts = 0;
  private attemptWindow = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly publicOrigin: string,
    private readonly defaultLeaseMs = DEFAULT_LEASE_MS,
  ) {}

  attachLocal(target: LocalConfigTarget): void {
    const parsed = new URL(target.origin);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.hash || parsed.search) {
      throw new DodoError('INTERNAL_ERROR', 'Local Config target is not an owner-private loopback capability');
    }
    this.target = target;
  }

  open(leaseMs = this.defaultLeaseMs): RemoteConfigLease {
    if (!this.target) throw new DodoError('NOT_SUPPORTED', 'Local Config is unavailable for this DODO process');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > DEFAULT_LEASE_MS) {
      throw new DodoError('INVALID_INPUT', 'Remote Config lifetime must not exceed 1 hour');
    }
    this.close();
    const expiresAt = Date.now() + leaseMs;
    this.ownerSession = this.target.createRemoteSession(expiresAt);
    const code = pairingCode();
    this.pairingHash = digest(code);
    this.expiresAt = expiresAt;
    this.pairingExpiresAt = Math.min(this.expiresAt, Date.now() + PAIRING_TTL_MS);
    this.attemptWindow = Date.now();
    this.timer = setTimeout(() => this.close(), leaseMs);
    this.timer.unref();
    return { url: `${this.publicOrigin}/config`, pairingCode: code, expiresAt: this.expiresAt };
  }

  close(): void {
    this.ownerSession?.revoke();
    this.ownerSession = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pairingHash = undefined;
    this.sessionHash = undefined;
    this.pairingExpiresAt = 0;
    this.expiresAt = 0;
    this.attempts = 0;
  }

  status(): RemoteConfigStatus {
    const active = this.active();
    return {
      active,
      paired: active && Boolean(this.sessionHash),
      url: `${this.publicOrigin}/config`,
      expiresAt: active ? this.expiresAt : null,
    };
  }

  mount(app: Express): void {
    app.get('/config/login.css', (req, res, next) => this.publicAsset(req, res, next, 'text/css; charset=utf-8', LOGIN_CSS));
    app.get('/config/login.js', (req, res, next) => this.publicAsset(req, res, next, 'text/javascript; charset=utf-8', LOGIN_JS));
    app.post('/config/pair', express.json({ limit: 2048 }), (req, res, next) => this.pair(req, res, next));
    app.use('/config/pair', (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (!this.active()) { res.status(404).end(); return; }
      securityHeaders(res);
      res.status(400).json({ error: 'Pairing request is invalid', code: 'INVALID_INPUT' });
      void error;
    });
    app.get(['/config', '/config/'], (req, res, next) => {
      if (!this.active()) { next(); return; }
      if (!this.authorized(req)) { securityHeaders(res); res.type('html').send(LOGIN_HTML); return; }
      this.proxy(req, res, '/', true);
    });
    app.use('/config/assets', (req, res, next) => {
      if (!this.active()) { next(); return; }
      if (!this.authorized(req)) { securityHeaders(res); res.status(401).end(); return; }
      if (req.method !== 'GET') { res.status(405).end(); return; }
      this.proxy(req, res, req.originalUrl.slice('/config'.length), false);
    });
    app.use('/config/api', (req, res, next) => {
      if (!this.active()) { next(); return; }
      if (!this.authorized(req)) {
        securityHeaders(res);
        res.status(401).json({ error: 'Remote Config requires pairing from the owner terminal', code: 'REMOTE_CONFIG_AUTH_REQUIRED' });
        return;
      }
      if (!['GET', 'POST'].includes(req.method)) { res.status(405).end(); return; }
      const origin = req.headers.origin;
      if ((origin && origin !== this.publicOrigin) || req.headers['sec-fetch-site'] === 'cross-site') {
        securityHeaders(res); res.status(403).end(); return;
      }
      this.proxy(req, res, req.originalUrl.slice('/config'.length), req.method === 'GET' && req.path === '/state');
    });
  }

  private active(): boolean {
    if (this.expiresAt > Date.now() && this.ownerSession?.active()) return true;
    if (this.expiresAt !== 0) this.close();
    return false;
  }

  private authorized(req: Request): boolean {
    return this.active() && sameDigest(this.sessionHash, cookie(req, COOKIE_NAME));
  }

  private publicAsset(req: Request, res: Response, next: NextFunction, type: string, body: Buffer): void {
    if (!this.active()) { next(); return; }
    securityHeaders(res);
    res.setHeader('Content-Type', type);
    res.send(body);
  }

  private pair(req: Request, res: Response, next: NextFunction): void {
    if (!this.active()) { next(); return; }
    securityHeaders(res);
    const origin = req.headers.origin;
    if ((origin && origin !== this.publicOrigin) || req.headers['sec-fetch-site'] === 'cross-site') { res.status(403).end(); return; }
    const now = Date.now();
    if (now - this.attemptWindow >= 60_000) { this.attemptWindow = now; this.attempts = 0; }
    this.attempts += 1;
    if (this.attempts > 10) { res.status(429).json({ error: 'Too many pairing attempts; run dodo --web to issue a new code', code: 'RATE_LIMITED' }); return; }
    const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    if (now > this.pairingExpiresAt || !sameDigest(this.pairingHash, code)) {
      res.status(401).json({ error: 'Pairing code is invalid or expired', code: 'INVALID_PAIRING_CODE' });
      return;
    }
    this.pairingHash = undefined; // one-time exchange
    const session = randomBytes(32).toString('base64url');
    this.sessionHash = digest(session);
    const maxAge = Math.max(1, Math.floor((this.expiresAt - now) / 1000));
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${session}; Path=/config; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`);
    res.json({ ok: true, expiresAt: this.expiresAt, redirect: '/config' });
  }

  private proxy(req: Request, res: Response, upstreamPath: string, transform: boolean): void {
    const target = this.target;
    const session = this.ownerSession;
    if (!target || !session?.active()) { securityHeaders(res); res.status(401).json({ error: 'Remote Config หมดอายุหรือปิดแล้ว — รัน dodo --web แล้วจับคู่ใหม่', code: 'REMOTE_CONFIG_AUTH_REQUIRED' }); return; }
    const local = new URL(target.origin);
    const headers: Record<string, string> = {
      Host: local.host,
      Authorization: `Bearer ${session.capability}`,
    };
    for (const [name, max] of [['content-type', 100], ['x-dodo-workspace', 256], ['x-dodo-epoch', 256]] as const) {
      const value = safeHeader(req, name, max);
      if (value) headers[name] = value;
    }
    const length = safeHeader(req, 'content-length', 20);
    if (length && /^\d+$/.test(length) && Number(length) <= 32 * 1024) headers['content-length'] = length;
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: Number(local.port),
      path: upstreamPath,
      method: req.method,
      headers,
    }, response => {
      const status = response.statusCode ?? 502;
      const type = typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : undefined;
      securityHeaders(res);
      res.status(status);
      if (type) res.setHeader('Content-Type', type);
      if (status === 401) {
        response.resume();
        res.json({ error: 'Remote Config หมดอายุหรือปิดแล้ว — รัน dodo --web แล้วจับคู่ใหม่', code: 'REMOTE_CONFIG_AUTH_REQUIRED' });
        return;
      }
      if (!transform || status !== 200) { response.pipe(res); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        if (size > 2 * 1024 * 1024) { res.status(502).json({ error: 'Remote Config response exceeded its bound' }); return; }
        let body = Buffer.concat(chunks);
        if (upstreamPath === '/') {
          body = Buffer.from(body.toString('utf8').replaceAll('"/assets/', '"/config/assets/'));
        } else if (upstreamPath.startsWith('/api/state')) {
          try {
            const parsed = JSON.parse(body.toString('utf8')) as { connection?: Record<string, unknown> };
            parsed.connection ??= {};
            parsed.connection['expiresAt'] = this.expiresAt;
            parsed.connection['remoteConfig'] = { active: true, expiresAt: this.expiresAt };
            body = Buffer.from(JSON.stringify(parsed));
          } catch { res.status(502).json({ error: 'Local Config returned invalid state' }); return; }
        }
        res.send(body);
      });
    });
    upstream.once('error', () => {
      if (!res.headersSent) { securityHeaders(res); res.status(502).json({ error: 'Local Config bridge is unavailable' }); }
      else res.end();
    });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
}

export { DEFAULT_LEASE_MS as REMOTE_CONFIG_LEASE_MS };
