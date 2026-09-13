import { describe, expect, it } from 'vitest';
import { staticResponse } from '../../src/services/multimodal/byteRange.js';

describe('bounded static-media HTTP ranges', () => {
  const bytes = Buffer.from('0123456789');
  it('returns complete bytes when no range was requested', () => {
    const response = staticResponse(bytes, 'video/mp4');
    expect(response.status).toBe(200); expect(response.body).toEqual(bytes);
    expect(response.headers['accept-ranges']).toBe('bytes');
  });
  it('returns an exact inclusive range with the full resource length', () => {
    const response = staticResponse(bytes, 'video/mp4', 'bytes=2-5');
    expect(response.status).toBe(206); expect(response.body.toString()).toBe('2345');
    expect(response.headers['content-range']).toBe('bytes 2-5/10'); expect(response.headers['content-length']).toBe('4');
  });
  it('supports open and suffix ranges without allocating beyond the resource', () => {
    expect(staticResponse(bytes, 'video/mp4', 'bytes=8-').body.toString()).toBe('89');
    expect(staticResponse(bytes, 'video/mp4', 'bytes=-3').body.toString()).toBe('789');
    expect(staticResponse(bytes, 'video/mp4', 'bytes=8-100000').body.toString()).toBe('89');
    expect(staticResponse(bytes, 'video/mp4', 'bytes=-100000').body.toString()).toBe('0123456789');
  });
  it('rejects empty, out-of-bounds, inverted, malformed and multi-range requests', () => {
    for (const range of ['bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=5-3', 'bytes=0-1,4-5', 'bytes=999999999999999999999-', 'items=0-1']) {
      const response = staticResponse(bytes, 'video/mp4', range);
      expect(response.status, range).toBe(416); expect(response.body.length).toBe(0); expect(response.headers['content-range']).toBe('bytes */10');
    }
    expect(staticResponse(Buffer.alloc(0), 'video/mp4', 'bytes=0-').status).toBe(416);
  });
});
