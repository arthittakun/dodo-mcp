// Same admission policy as privateFs.ts, using inbox .NET ACL APIs directly.
// Target and mode are environment DATA. No shell, arbitrary SID, elevation or
// permission-result cache. Every invocation rereads owner, DACL and attributes.
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

class DodoPrivateState {
  static readonly AccessControlSections Sections = AccessControlSections.Owner | AccessControlSections.Access;
  static void Require(bool ok) { if (!ok) throw new InvalidOperationException(); }
  static FileSystemSecurity Read(string path, bool directory) {
    return directory ? (FileSystemSecurity)Directory.GetAccessControl(path, Sections) : File.GetAccessControl(path, Sections);
  }
  static void Write(string path, bool directory, FileSystemSecurity acl) {
    if (directory) Directory.SetAccessControl(path, (DirectorySecurity)acl);
    else File.SetAccessControl(path, (FileSecurity)acl);
  }
  static void PrivateDacl(FileSystemSecurity acl, string sid) {
    bool ownerAllowed = false;
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.AccessControlType != AccessControlType.Allow) continue;
      string id = rule.IdentityReference.Value;
      Require(id == sid || id == "S-1-5-18" || id == "S-1-5-32-544");
      if (id == sid) ownerAllowed = true;
    }
    Require(ownerAllowed);
  }
  static FileAttributes Attributes(string path) {
    FileAttributes value = File.GetAttributes(path);
    Require((value & FileAttributes.ReparsePoint) == 0);
    return value;
  }
  static void Verify(string path, string mode) {
    Require(!String.IsNullOrEmpty(path) && Path.IsPathRooted(path));
    bool directory = (Attributes(path) & FileAttributes.Directory) != 0;
    using (WindowsIdentity current = WindowsIdentity.GetCurrent()) {
      SecurityIdentifier sid = current.User;
      SecurityIdentifier admin = new SecurityIdentifier("S-1-5-32-544");
      WindowsPrincipal principal = new WindowsPrincipal(current);
      FileSystemSecurity acl = Read(path, directory);
      string owner = acl.GetOwner(typeof(SecurityIdentifier)).Value;
      bool repairAdminOwner = owner == admin.Value && principal.IsInRole(admin);
      Require(owner == sid.Value || repairAdminOwner);
      if (mode == "protect") {
        Require(directory);
        DirectorySecurity next = new DirectorySecurity();
        next.SetOwner(sid);next.SetAccessRuleProtection(true, false);
        foreach (string id in new string[] { sid.Value, "S-1-5-18", admin.Value })
          next.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id), FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Write(path, true, next);
      } else if (mode == "verify") {
        PrivateDacl(acl, sid.Value);
        if (repairAdminOwner) {
          string before = acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
          acl.SetOwner(sid);Write(path, directory, acl);
          Require(Read(path, directory).GetSecurityDescriptorSddlForm(AccessControlSections.Access) == before);
        }
      } else throw new InvalidOperationException();
      Require(((Attributes(path) & FileAttributes.Directory) != 0) == directory);
      FileSystemSecurity final = Read(path, directory);
      Require(final.GetOwner(typeof(SecurityIdentifier)).Value == sid.Value);
      PrivateDacl(final, sid.Value);
    }
  }
  static int Main() {
    try {
      Verify(Environment.GetEnvironmentVariable("DODO_PRIVATE_PATH"), Environment.GetEnvironmentVariable("DODO_PRIVATE_MODE"));
      Console.Write("private");return 0;
    } catch { Console.Error.Write("private ACL verification failed");return 1; }
  }
}
