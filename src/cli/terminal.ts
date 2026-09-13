/** Only CLI presentation is colored; SDK output, JSON and redirected logs stay plain. */
export function formatTerminalLine(line: string, color = Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb'): string {
  if (!color) return line;
  const paint = (code: string, value: string) => `\x1b[${code}m${value}\x1b[0m`;
  if (line.startsWith('DODO ')) return '\n' + paint('1;36', line);
  if (line.startsWith('[dodo] Private config')) {
    const i = line.indexOf('http://');
    return '\n' + paint('1;35', 'LOCAL CONFIG · private link (8h)') + '\n' + paint('36', line.slice(i)) + '\n';
  }
  const i = line.indexOf(':');
  if (i < 0) return paint('2', line);
  const label = line.slice(0, i + 1);
  const value = line.slice(i + 1);
  let code = '37';
  if (/^(Workspace:|MCP:|Public:)/.test(line)) code = '36';
  if (/^(Workspace ID:|State:|Tunnel:)/.test(line)) code = '2';
  if (line.startsWith('Auth:')) code = line.includes('LOCKED') ? '33' : '32';
  if (line.startsWith('Exec:')) code = '33';
  if (line.includes('WARNING') || line.includes('bypass:') || line.includes('allow-all:')) code = '33';
  return paint('1', label) + paint(code, value);
}
