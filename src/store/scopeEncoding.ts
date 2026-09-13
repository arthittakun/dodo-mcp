/** Fail closed for malformed ACLs; migration alone accepts legacy space lists. */
export function decodeAccessScopes(raw: string, legacy = false): string[] {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { value = legacy ? raw.trim().split(/\s+/).filter(Boolean) : null; }
  const allowed = ['dodo:read', 'dodo:write', 'dodo:exec'];
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && allowed.includes(v))) return [];
  return [...new Set(value as string[])];
}
