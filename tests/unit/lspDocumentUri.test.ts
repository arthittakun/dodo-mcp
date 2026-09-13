import { describe, it, expect } from 'vitest';
import { documentUri } from '../../src/services/lsp/documentUri.js';

describe('LSP diagnostic document identity', () => {
  it('matches pyright encoded drive URIs with didOpen URIs on Windows', () => {
    expect(documentUri('file:///C:/work/a%20b.py', 'win32')).toBe('file:///c:/work/a%20b.py');
    expect(documentUri('file:///c%3A/work/a%20b.py', 'win32')).toBe('file:///c:/work/a%20b.py');
  });
  it('preserves file-name case and rejects non-file URLs', () => {
    expect(documentUri('file:///tmp/A.py', 'darwin')).not.toBe(documentUri('file:///tmp/a.py', 'darwin'));
    expect(documentUri('file:///C:/work/A.py', 'win32')).not.toBe(documentUri('file:///c:/work/a.py', 'win32'));
    expect(documentUri('https://example.test/a.py', 'win32')).toBeUndefined();
    expect(documentUri('file:///c:/bad%2Fpath', 'win32')).toBeUndefined();
  });
});
