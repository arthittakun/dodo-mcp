import type { AdbBackend, AdbResult } from '../../src/services/android/protocol.js';

// 1x1 transparent PNG; enough to exercise MCP image passthrough without Sharp.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

export class FakeAdb implements AdbBackend {
  calls: string[][] = [];
  installed = true;
  failNext = false;

  available(): boolean { return this.installed; }
  async version(): Promise<string> { return 'Android Debug Bridge version 1.0.41'; }

  async run(args: readonly string[]): Promise<AdbResult> {
    this.calls.push([...args]);
    if (this.failNext) { this.failNext = false; throw new Error('simulated ADB disconnect'); }
    let stdout = Buffer.alloc(0), code = 0;
    const joined = args.join(' ');
    if (joined === 'devices -l') stdout = Buffer.from('List of devices attached\nSERIAL-1 device product:fixture model:Pixel_9 device:fixture transport_id:1\nOTHER-2 unauthorized usb:1-2\n');
    else if (joined === '-s SERIAL-1 get-state') stdout = Buffer.from('device\n');
    else if (joined === '-s OTHER-2 get-state') { stdout = Buffer.from('unauthorized\n'); code = 1; }
    else if (joined === '-s SERIAL-1 exec-out screencap -p') stdout = PNG;
    else if (joined === '-s SERIAL-1 shell getprop') stdout = Buffer.from('[ro.product.manufacturer]: [Google]\n[ro.product.model]: [Pixel 9]\n[ro.product.device]: [fixture]\n[ro.build.version.release]: [16]\n[ro.build.version.sdk]: [36]\n[ro.product.cpu.abi]: [arm64-v8a]\n');
    else if (joined === '-s SERIAL-1 shell wm size') stdout = Buffer.from('Physical size: 1080x2400\n');
    else if (joined === '-s SERIAL-1 shell dumpsys battery') stdout = Buffer.from('  AC powered: false\n  USB powered: true\n  status: 2\n  level: 88\n');
    else if (joined === '-s SERIAL-1 shell uiautomator dump /dev/tty') stdout = Buffer.from('<?xml version="1.0"?><hierarchy><node index="0" text="Visible" resource-id="app:id/title" class="android.widget.TextView" package="app.test" clickable="true" enabled="true" focusable="false" password="false" bounds="[0,0][1,1]"/><node index="1" text="SECRET" class="android.widget.EditText" package="app.test" password="true" bounds="[0,0][1,1]"/></hierarchy>');
    else if (joined.includes(' logcat ')) stdout = Buffer.from('09-16 I/Test: hello\n09-16 W/Test: warning\n');
    else if (joined === '-s SERIAL-1 shell pm list packages -3') stdout = Buffer.from('package:app.test\npackage:dev.dodo.fixture\n');
    else if (joined === '-s SERIAL-1 exec-out cat -- /sdcard/test.txt') stdout = Buffer.from('device file\n');
    else if (joined.startsWith('-s SERIAL-1 shell input ')) stdout = Buffer.alloc(0);
    else if (joined.startsWith('-s SERIAL-1 shell monkey ') || joined.startsWith('-s SERIAL-1 shell am ') || joined.startsWith('-s SERIAL-1 shell pm clear ')) stdout = Buffer.from('Success\n');
    else if (joined.includes(' install ')) stdout = Buffer.from('Success\n');
    else if (joined.includes(' push ')) stdout = Buffer.from('1 file pushed\n');
    else if (joined.startsWith('-s SERIAL-1 shell ')) stdout = Buffer.from('advanced output\n');
    else if (joined === '-s SERIAL-1 features') stdout = Buffer.from('shell_v2\ncmd\n');
    else { code = 1; }
    return { code, stdout, stderr: code === 0 ? Buffer.alloc(0) : Buffer.from('fixture adb error') };
  }
}
