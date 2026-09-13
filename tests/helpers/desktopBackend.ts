import type { DesktopBackend } from '../../src/services/desktop/protocol.js';
const win = { windowId: 42, pid: 123, appId: 'dev.dodo.fixture', title: 'Fixture', bounds: { x: 100, y: 200, width: 800, height: 600 } };
const capture = { ...win, imageWidth: 800, imageHeight: 600, mimeType: 'image/jpeg', image: '/9j/2Q==' };
export class FakeDesktop implements DesktopBackend {
    calls: Record<string, unknown>[] = [];
    installed = true;
    failure = false;
    wait: Promise<void> | undefined;
    available() { return this.installed; }
    async run(request: Record<string, unknown>) {
        this.calls.push(request);
        if (this.wait)
            await this.wait;
        if (this.failure)
            throw new Error('simulated native disconnect');
        switch (request['op']) {
            case 'status': return { screenRecording: true, accessibility: true, platform: 'darwin', backend: 'test adapter' };
            case 'windows': return { windows: [win, { ...win, windowId: 99, appId: 'secret.other.app' }], truncated: false };
            case 'capture': return capture;
            case 'accessibility': return { elements: [{ role: 'AXTextField', redacted: true, depth: 1 }], truncated: false };
            case 'action': return { posted: true, note: 'fixture event posted' };
            default: throw Error('unexpected operation');
        }
    }
}
