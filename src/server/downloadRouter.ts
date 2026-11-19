import type { FileHandle } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express, NextFunction, Request, Response } from 'express';

export interface DownloadReader {
  openDownload(token: string): Promise<{
    handle: FileHandle;
    bytes: number;
    mimeType: string;
    filename: string;
    expiresAt: number;
    assertActive: () => void;
  }>;
}

function headers(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
}

function byteRange(raw: string, bytes: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2]) || bytes === 0) return undefined;
  const left = match[1] ? Number(match[1]) : undefined;
  const right = match[2] ? Number(match[2]) : undefined;
  if ((left !== undefined && !Number.isSafeInteger(left)) || (right !== undefined && !Number.isSafeInteger(right))) return undefined;
  if (left === undefined) {
    if (!right || right < 0) return undefined;
    return { start: Math.max(0, bytes - right), end: bytes - 1 };
  }
  if (left >= bytes || (right !== undefined && right < left)) return undefined;
  return { start: left, end: Math.min(right ?? bytes - 1, bytes - 1) };
}

/** Public bearer-capability downloads; no filesystem path comes from the URL. */
export function mountDownloadRouter(app: Express, downloads: DownloadReader): void {
  let inFlight = 0;
  app.get('/file/:token/:filename', async (req, res) => {
    headers(res);
    const token = req.params['token'];
    const filename = req.params['filename'];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || typeof filename !== 'string') {
      res.status(404).json({ error: 'not_found' }); return;
    }
    if (inFlight >= 16) {
      res.status(503).setHeader('Retry-After', '1').json({ error: 'busy' }); return;
    }
    inFlight += 1;
    let opened: Awaited<ReturnType<DownloadReader['openDownload']>> | undefined;
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.once('close', onClose);
    try {
      opened = await downloads.openDownload(token);
      if (filename !== opened.filename || res.destroyed) {
        if (!res.destroyed) res.status(404).json({ error: 'not_found' });
        return;
      }
      opened.assertActive();
      const total = opened.bytes;
      let start = 0, end = total - 1;
      // A supplied If-Range cannot be validated without a persistent validator;
      // returning the full representation is the HTTP-defined fallback.
      const range = req.headers.range;
      if (range !== undefined && req.headers['if-range'] === undefined) {
        const selected = byteRange(range, total);
        if (!selected) {
          res.status(416).setHeader('Content-Range', `bytes */${total}`).end(); return;
        }
        ({ start, end } = selected);
        res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      }
      const asciiName = opened.filename.replace(/[^A-Za-z0-9._-]/g, '_');
      const encodedName = encodeURIComponent(opened.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      res.setHeader('Content-Type', opened.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', total === 0 ? 0 : end - start + 1);
      if (req.method === 'HEAD' || total === 0) { res.end(); return; }
      const assertActive = opened.assertActive;
      const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        try { assertActive(); callback(null, chunk); } catch { callback(new Error('download unavailable')); }
      } });
      await pipeline(opened.handle.createReadStream({ start, end, autoClose: false }), guard, res, { signal: abort.signal });
    } catch {
      if (!res.headersSent && !res.destroyed) res.status(404).json({ error: 'not_found' });
      else if (!res.destroyed) res.destroy();
    } finally {
      res.removeListener('close', onClose);
      await opened?.handle.close().catch(() => undefined);
      inFlight -= 1;
    }
  });
  app.use('/file', (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!(error instanceof URIError)) { next(error); return; }
    // Express decodes route parameters before entering the handler. Keep bad
    // encodings on this public namespace out of its diagnostic error page.
    headers(res);
    res.status(404).json({ error: 'not_found' });
  });
}
