import { describe, expect, it } from 'vitest';
import { parseAdbDevices } from '../../src/services/android/adbBackend.js';
import { __androidTest, parseUiHierarchy } from '../../src/services/android/androidService.js';

describe('Android ADB parsing and path boundaries', () => {
  it('parses exact serial/state/device fields and ignores daemon chatter', () => {
    expect(parseAdbDevices('List of devices attached\n* daemon started successfully *\nabc:5555 device product:x model:Pixel_9 device:y transport_id:7\nbad unauthorized usb:1\n')).toEqual([
      { serial: 'abc:5555', state: 'device', product: 'x', model: 'Pixel_9', device: 'y', transportId: '7' },
      { serial: 'bad', state: 'unauthorized' },
    ]);
  });

  it('parses PNG dimensions without loading Sharp', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    expect(__androidTest.pngDimensions(png)).toEqual({ width: 1, height: 1 });
    expect(() => __androidTest.pngDimensions(Buffer.from('no'))).toThrow(/valid PNG/);
  });

  it('redacts password text and bounds hierarchy output', () => {
    const xml = '<hierarchy><node text="hello &amp; bye" class="Text" package="a.b" password="false" bounds="[1,2][11,22]"/><node text="secret" content-desc="pin" class="Edit" package="a.b" password="true" bounds="[0,0][1,1]"/></hierarchy>';
    const result = parseUiHierarchy(xml, 1);
    expect(result).toMatchObject({ truncated: true, nodes: [{ text: 'hello & bye', bounds: { x: 1, y: 2, width: 10, height: 20 } }] });
    const password = parseUiHierarchy(xml, 2).nodes[1]!;
    expect(password).toMatchObject({ redacted: true });
    expect(password).not.toHaveProperty('text');
    expect(password).not.toHaveProperty('description');
  });

  it('requires absolute traversal-free Android device paths', () => {
    expect(__androidTest.devicePath('/sdcard/a.txt')).toBe('/sdcard/a.txt');
    for (const value of ['sdcard/a', '/sdcard/../data/a', '/x\ny']) expect(() => __androidTest.devicePath(value)).toThrow();
  });
});

