/** Shared classification only; each consumer must still require its own owner network permission. */
export function addressClass(ip: string): 'public' | 'private' | 'denied' {
  ip = ip.toLowerCase().replace(/^::ffff:/, '');
  if (ip.includes(':')) {
    if (ip.startsWith('2002:') || ip.startsWith('2001:0:') || ip === '::' || /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.includes('.')) return 'denied';
    if (ip === '::1' || /^f[cd]/.test(ip)) return 'private';
    if (!ip.startsWith('2') && !ip.startsWith('3')) return 'denied';
    return 'public';
  }
  const [a = 0,b = 0] = ip.split('.').map(Number);
  if (a === 0 || (a === 169 && b === 254) || a >= 224 || (a === 100 && b >= 64 && b <= 127)) return 'denied';
  if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  return 'public';
}
