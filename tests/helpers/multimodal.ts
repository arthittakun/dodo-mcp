import sharp from 'sharp';
import { z } from 'zod';
import type { DesktopBackend } from '../../src/services/desktop/protocol.js';
import { callToolLegacy, wsArgs, type TestContext } from './testServer.js';

export const Block = z.object({ type: z.string(), data: z.string().optional(), mimeType: z.string().optional(), text: z.string().optional() });
export async function tool(ctx: TestContext, token: string, name: string, args: Record<string, unknown>) {
  return callToolLegacy(ctx, token, name, { ...wsArgs(ctx), ...args });
}
export function blocks(result: Awaited<ReturnType<typeof tool>>) {
  return z.object({ result: z.object({ content: z.array(Block) }) }).parse(result.raw).result.content;
}
export function assertOk(result: Awaited<ReturnType<typeof tool>>): unknown {
  if (result.isError || result.envelope.ok !== true) throw new Error(JSON.stringify(result.envelope.error));
  return result.envelope.data;
}
export class ImageDesktop implements DesktopBackend {
  calls: Record<string, unknown>[] = [];
  image = '';
  installed = true;
  text = 'Ready Save';
  async prepare(background = '#224488') { this.image = (await sharp({ create: { width: 640, height: 480, channels: 3, background } }).jpeg().toBuffer()).toString('base64'); }
  available() { return this.installed; }
  async run(request: Record<string, unknown>) {
    this.calls.push(request);
    const window = { windowId: 42, pid: 123, appId: 'dev.dodo.fixture', title: 'Fixture game', bounds: { x: 10, y: 20, width: 640, height: 480 } };
    switch (request.op) {
      case 'status': return { screenRecording: true, accessibility: true, platform: 'darwin', backend: 'test-image-adapter' };
      case 'windows': return { windows: [window], truncated: false };
      case 'capture': return { ...window, imageWidth: 640, imageHeight: 480, mimeType: 'image/jpeg', image: this.image };
      case 'accessibility': return { elements: [{ role: 'AXStaticText', depth: 1, value: this.text }], truncated: false };
      case 'action': this.text = 'Saved'; return { posted: true, note: 'test OS event' };
      default: throw new Error('unexpected desktop call');
    }
  }
}
export const BROWSER_FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>DODO test world</title></head><body>
<h1>Ready</h1><label for="name">Name</label><input id="name"><button id="save">Save</button>
<p id="saved">Nothing saved</p><button id="count">Increment</button><p id="counter">Count 0</p>
<p id="keys">Held none</p><p id="moves">Moves 0</p>
<input id="password" type="password" value="NEVER_READ_PASSWORD">
<video id="clip" src="sample.mp4" width="320" height="180" muted controls></video><p id="position">Position 0</p>
<button id="change">Change page</button><button id="network">Attempt network</button><p id="networkState"></p>
<script>
let count=0,moves=0; const held=new Set();
document.querySelector('#save').onclick=()=>{document.querySelector('#saved').textContent='Saved '+document.querySelector('#name').value;console.log('saved fixture');};
document.querySelector('#count').onclick=()=>{document.querySelector('#counter').textContent='Count '+(++count);};
document.addEventListener('keydown',e=>{held.add(e.key);document.querySelector('#keys').textContent='Held '+[...held].join(',');document.querySelector('#moves').textContent='Moves '+(++moves);});
document.addEventListener('keyup',e=>{held.delete(e.key);document.querySelector('#keys').textContent='Held '+([...held].join(',')||'none');});
document.querySelector('#clip').ontimeupdate=()=>{document.querySelector('#position').textContent='Position '+Math.floor(document.querySelector('#clip').currentTime);};
document.querySelector('#change').onclick=()=>{document.querySelector('h1').textContent='Changed';};
document.querySelector('#network').onclick=()=>{Promise.allSettled([fetch('http://127.0.0.1:21731/'),fetch('/.env'),fetch('https://example.com/')]).then(()=>{document.querySelector('#networkState').textContent='Network requests finished';});};
</script></body></html>`;
