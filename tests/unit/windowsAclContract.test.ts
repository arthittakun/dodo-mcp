import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-structure regression checks, NOT emulation of NTFS, PowerShell or UAC.
// Real owner/DACL behavior is covered by windowsAclOwner.test.ts on Windows.
const source = fs.readFileSync(new URL('../../src/platform/privateFs.ts', import.meta.url), 'utf8');
const script = /const ACL_SCRIPT = String\.raw`([\s\S]*?)`;/u.exec(source)?.[1];
if (!script) throw new Error('missing constant ACL script');
const protect = script.slice(script.indexOf("if ($env:DODO_PRIVATE_MODE -eq 'protect')"), script.indexOf("} elseif ($env:DODO_PRIVATE_MODE -eq 'verify')"));
const verify = script.slice(script.indexOf("} elseif ($env:DODO_PRIVATE_MODE -eq 'verify')"), script.indexOf("} else { throw 'invalid private ACL mode' }"));
const final = script.slice(script.indexOf('# Do not trust Set-Acl succeeding:'));

describe('Windows ACL source contract (not native Windows evidence)', () => {
  it('admits only the current owner or Administrators with effective token membership', () => {
    expect(script).toContain("[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')");
    expect(script).toContain('$repairAdminOwner = ($owner -eq $administratorsSid.Value) -and $principal.IsInRole($administratorsSid)');
    expect(script).toContain("if ($owner -ne $sid.Value -and -not $repairAdminOwner) { throw 'unexpected owner' }");
    expect(script!.indexOf("throw 'unexpected owner'")).toBeLessThan(script!.indexOf("if ($env:DODO_PRIVATE_MODE -eq 'protect')"));
  });
  it('protect sets the user owner and an explicit private directory DACL', () => {
    expect(protect).toContain('$acl.SetOwner($sid)');
    expect(protect).toContain('$acl.SetAccessRuleProtection($true, $false)');
    expect(protect).toContain("'FullControl', 'ContainerInherit, ObjectInherit'");
    expect(protect).toContain('Set-Acl -LiteralPath $p -AclObject $acl');
    expect(script).toContain("$allowed = @($sid.Value, 'S-1-5-18', $administratorsSid.Value)");
  });
  it('verify checks the existing DACL before any restricted owner repair', () => {
    expect(verify.indexOf('Assert-PrivateDacl $acl')).toBeGreaterThan(-1);
    expect(verify.indexOf('Assert-PrivateDacl $acl')).toBeLessThan(verify.indexOf('if ($repairAdminOwner)'));
    expect(verify).toContain('$acl.SetOwner($sid)');
    expect(verify).not.toContain('AddAccessRule');
    expect(verify).not.toContain('SetAccessRuleProtection');
    expect(verify).toContain("throw 'DACL changed during owner repair'");
  });
  it('rereads owner and DACL after both protect and verify', () => {
    expect(final).toContain('$acl = Get-Acl -LiteralPath $p');
    expect(final).toContain("if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unexpected owner after ACL operation' }");
    expect(final).toContain('Assert-PrivateDacl $acl');
    expect(final.indexOf('Assert-PrivateDacl $acl')).toBeLessThan(final.indexOf("[Console]::Write('private')"));
  });
  it('retains reparse rejection before and after ACL operations and hard errors', () => {
    expect(script!.match(/throw 'reparse point'/gu)).toHaveLength(2);
    expect(script).toContain("if ($allowed -notcontains $rule.IdentityReference.Value) { throw 'non-private DACL' }");
    expect(source).toContain("throw new DodoError('PATH_DENIED', 'private Windows state ACL could not be established or verified");
  });
  it('keeps the target as environment data in constant PowerShell source', () => {
    expect(script).toContain('$p = $env:DODO_PRIVATE_PATH');
    expect(script).not.toContain('${');
    expect(script).not.toContain('Invoke-Expression');
    expect(source).toContain('DODO_PRIVATE_PATH: target');
    expect(source).toContain("'-EncodedCommand', Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64')");
  });
});
