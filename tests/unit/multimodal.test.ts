import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { imageView, imageDifference } from '../../src/services/multimodal/images.js';
import { parseSubtitles } from '../../src/services/multimodal/mediaService.js';
import { isPublicAddress, validatePublicUrl } from '../../src/services/multimodal/network.js';
import { BrowserAction, GameAction, Workflow, WorkerSpec } from '../../src/services/multimodal/contracts.js';
import { MULTIMODAL_TOOLS } from '../../src/tools/multimodalTools.js';

const picture = (background: string) => sharp({ create: { width: 640, height: 480, channels: 3, background } }).png().toBuffer();
describe('multimodal image math and input validation', () => {
  it('returns real JPEG and exact crop/source coordinate mapping', async () => {
    const result = await imageView(await picture('#102030'), 800, { left: 100, top: 50, width: 200, height: 100 });
    const image = await sharp(result.bytes).metadata();
    expect(image.format).toBe('jpeg'); expect(image.width).toBe(800); expect(image.height).toBe(400);
    expect(result.view).toMatchObject({ sourceWidth: 640, sourceHeight: 480, sourceOffsetX: 100, sourceOffsetY: 50, scaleX: 0.25, scaleY: 0.25 });
  });
  it('never enlarges a full image or fabricates cropped resolution', async () => {
    const result = await imageView(await picture('#123456'), 1600);
    expect(result.view.width).toBe(640); expect(result.view.scaleX).toBe(1);
  });
  it('refuses an out-of-image crop', async () => {
    await expect(imageView(await picture('#000000'), 640, { left: 600, top: 1, width: 100, height: 100 })).rejects.toThrow(/outside/);
  });
  it('rejects executable/HTML text disguised as an image', async () => {
    await expect(imageView(Buffer.from('<svg><script>alert(1)</script></svg>'), 640)).rejects.toThrow();
  });
  it('reports zero pixel difference for identical images and change for different frames', async () => {
    const a = await picture('#000000'), b = await picture('#ffffff');
    expect(await imageDifference(a, a)).toBe(0); expect(await imageDifference(a, b)).toBe(1);
  });
  it('parses Thai SRT with millisecond timing and HTML stripped', () => {
    expect(parseSubtitles('1\r\n00:00:01,200 --> 00:00:03,400\r\n<b>สวัสดี</b> world\r\n\r\n')).toEqual([{ startSec: 1.2, endSec: 3.4, text: 'สวัสดี world' }]);
  });
  it('parses WebVTT short timestamps and cue settings', () => {
    expect(parseSubtitles('WEBVTT\n\ncue\n01:02.500 --> 01:05.000 align:start\nHello\nthere\n\n')[0]).toEqual({ startSec: 62.5, endSec: 65, text: 'Hello\nthere' });
  });
  it('refuses missing or backwards subtitle timing', () => {
    expect(() => parseSubtitles('not a transcript')).toThrow(/no valid/);
    expect(() => parseSubtitles('00:00:03.000 --> 00:00:01.000\nbackwards\n')).toThrow(/invalid/);
  });
  it('allows only public addresses, excluding common SSRF aliases', () => {
    for (const ip of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '169.254.169.254', '100.64.0.1', '172.16.0.1', '192.168.2.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true); expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects private URLs, unexpected origins, credentials and DODO own origin', () => {
    for (const url of ['http://localhost:21731', 'http://127.1:21731', 'file:///etc/passwd', 'https://u:p@example.com', 'https://other.example.com']) expect(() => validatePublicUrl(url, new Set(['https://example.com', 'http://localhost:21731', 'http://127.0.0.1:21731']))).toThrow();
    expect(() => validatePublicUrl('https://example.com', new Set(['https://example.com']), 'https://example.com')).toThrow();
    expect(validatePublicUrl('https://example.com/path', new Set(['https://example.com'])).pathname).toBe('/path');
  });
  it('rejects raw-JS/browser escape actions and caps game holds/combinations', () => {
    expect(BrowserAction.safeParse({ kind: 'evaluate', script: 'process.exit()' }).success).toBe(false);
    expect(GameAction.safeParse({ kind: 'keys', keys: ['a'], holdMs: 501 }).success).toBe(false);
    expect(GameAction.safeParse({ kind: 'keys', keys: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
    expect(GameAction.safeParse({ kind: 'keys', keys: ['Meta'] }).success).toBe(false);
  });
  it('requires explicit workflow preconditions and rejects permission-changing steps', () => {
    expect(Workflow.safeParse({ name: 'bad', goal: 'test', steps: [{ instruction: 'x', action: { target: 'shell', command: 'dodo trust --yes' } }] }).success).toBe(false);
    expect(Workflow.safeParse({ name: 'good', goal: 'test', steps: [{ instruction: 'click', expectedBefore: 'Ready', action: { target: 'browser', action: { kind: 'click', selector: '#save' } } }] }).success).toBe(true);
  });
  it('bounds decoder requests and exposes exactly the expected 20 implemented tools', () => {
    expect(WorkerSpec.safeParse({ operation: 'remote_url', url: 'http://localhost' }).success).toBe(false);
    expect(MULTIMODAL_TOOLS).toHaveLength(20);
    expect(new Set(MULTIMODAL_TOOLS.map(t => t.name)).size).toBe(20);
    for (const t of MULTIMODAL_TOOLS) expect(Object.keys((t.output as unknown as { shape: object }).shape).length).toBeGreaterThan(0);
  });
});
