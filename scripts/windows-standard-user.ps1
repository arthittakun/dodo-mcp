# Owner-dispatched native CI only. Temporary account credentials stay in memory.
# No production state, existing account, machine PATH or security policy is changed.
$ErrorActionPreference = 'Stop'
$phase = 'preflight'
$created = $false
$account = $null
$fixture = $null
$result = @{ scope = 'windows-standard-user'; checks = @(); complete = $false; cleanup = $false }
$evidence = $env:DODO_CI_EVIDENCE
New-Item -ItemType Directory -Force $evidence | Out-Null
function Protect-Fixture([string]$Target, [Security.Principal.SecurityIdentifier]$UserSid) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($id in @($UserSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($id), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
  }
  Set-Acl -LiteralPath $Target -AclObject $acl
}
try {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'fixture provisioning needs administrator' }
  $phase = 'build-and-pack'
  & npm.cmd run build *> (Join-Path $evidence 'build-private.log')
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  $pack = & npm.cmd pack --json --pack-destination $evidence 2> (Join-Path $evidence 'pack-private.log')
  if ($LASTEXITCODE -ne 0) { throw 'pack failed' }
  $tarball = ($pack | ConvertFrom-Json)[0].filename
  $phase = 'create-standard-account'
  $name = 'ddci' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
  $random = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($random); $rng.Dispose()
  $password = ConvertTo-SecureString ('Dd9!' + [Convert]::ToBase64String($random)) -AsPlainText -Force
  [Array]::Clear($random, 0, $random.Length)
  $account = New-LocalUser -Name $name -Password $password -Description 'Disposable DODO standard-user CI fixture' -AccountExpires (Get-Date).AddHours(2)
  $created = $true
  Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')) -Member $account
  if (@(Get-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')) | Where-Object { $_.SID -eq $account.SID }).Count) { throw 'fixture is an administrator' }
  $phase = 'prepare-fixture'
  $fixture = Join-Path $env:ProgramData ('ddci-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
  New-Item -ItemType Directory $fixture | Out-Null
  Protect-Fixture $fixture $account.SID
  $phase = 'copy-node-toolchain'
  $toolchain = Join-Path $fixture 'node'
  New-Item -ItemType Directory $toolchain | Out-Null
  $nodeExe = (Get-Command node.exe -CommandType Application).Source
  $nodeRoot = Split-Path -Parent $nodeExe
  Copy-Item -LiteralPath $nodeExe -Destination $toolchain
  foreach ($shim in @('npm.cmd','npx.cmd')) { Copy-Item -LiteralPath (Join-Path $nodeRoot $shim) -Destination $toolchain }
  $phase = 'copy-npm-toolchain'
  New-Item -ItemType Directory (Join-Path $toolchain 'node_modules') | Out-Null
  # Use Node's Unicode/long-path aware APIs and dereference tool-cache links.
  $copyLog = Join-Path $evidence 'toolchain-copy-private.log'
  & $nodeExe -e 'require(''node:fs'').cpSync(process.argv[1], process.argv[2], {recursive:true,dereference:true});' (Join-Path $nodeRoot 'node_modules/npm') (Join-Path $toolchain 'node_modules/npm') *> $copyLog
  if ($LASTEXITCODE -ne 0) { throw 'toolchain copy failed' }
  $phase = 'copy-test-artifact'
  Copy-Item -LiteralPath (Join-Path $evidence $tarball) -Destination (Join-Path $fixture 'package.tgz')
  foreach ($script in @('windows-standard-user-child.ps1','windows-standard-user-child.mjs')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination $fixture
  }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../tests/helpers/nativeAclDiagnostics.mjs') -Destination $fixture
  $phase = 'prepare-admin-owned-fixture'
  # Reproduce a readable, private installation whose owner is Administrators.
  # Standard-user rejection must be reported as a reproduction, not a success.
  $mixed = Join-Path $fixture 'admin-created-state'
  New-Item -ItemType Directory (Join-Path $mixed 'tools') -Force | Out-Null
  Protect-Fixture $mixed $account.SID
  [IO.File]::WriteAllText((Join-Path $mixed 'managed-tools.json'), '{"version":1,"paths":[]}')
  $manifest = Get-Acl -LiteralPath (Join-Path $mixed 'managed-tools.json')
  $manifest.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  Set-Acl -LiteralPath (Join-Path $mixed 'managed-tools.json') -AclObject $manifest
  $plan = @{ fixture = $fixture; expectedSid = $account.SID.Value; node = (Join-Path $toolchain 'node.exe'); mixedState = $mixed }
  $phase = 'write-fixture-plan'
  [IO.File]::WriteAllText((Join-Path $fixture 'plan.json'), ($plan | ConvertTo-Json -Compress))
  $temp = Join-Path $fixture 'temp'
  New-Item -ItemType Directory $temp | Out-Null
  $phase = 'run-as-standard-user'
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' + (Join-Path $fixture 'windows-standard-user-child.ps1') + '"'
  $start.WorkingDirectory = $fixture
  $start.UseShellExecute = $false
  $start.LoadUserProfile = $true
  $start.CreateNoWindow = $true
  $start.UserName = $name; $start.Domain = $env:COMPUTERNAME; $start.Password = $password
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  # Never inherit runner tokens, npm config, state overrides or its profile.
  $start.EnvironmentVariables.Clear()
  foreach ($key in @('SystemRoot','WINDIR','SystemDrive','COMPUTERNAME','ProgramData','ProgramFiles','PROCESSOR_ARCHITECTURE')) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value) { $start.EnvironmentVariables[$key] = $value }
  }
  $start.EnvironmentVariables['TEMP'] = $temp; $start.EnvironmentVariables['TMP'] = $temp
  $start.EnvironmentVariables['PATH'] = $toolchain + ';' + (Join-Path $env:SystemRoot 'System32') + ';' + $env:SystemRoot + ';' + (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0')
  $start.EnvironmentVariables['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'standard-user launch failed' }
  $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(2100000)) { throw 'standard-user fixture timed out' }
  [IO.File]::WriteAllText((Join-Path $evidence 'child-private.log'), $stdout.Result + $stderr.Result)
  $resultFile = Join-Path $fixture 'result.json'
  if (-not (Test-Path -LiteralPath $resultFile)) { throw 'no standard-user result' }
  $result = Get-Content -Raw -LiteralPath $resultFile | ConvertFrom-Json
  $result | Add-Member -NotePropertyName childExitCode -NotePropertyValue $process.ExitCode -Force
  $phase = 'retain-private-evidence'
  if (Test-Path -LiteralPath (Join-Path $fixture 'logs')) {
    Copy-Item -LiteralPath (Join-Path $fixture 'logs') -Destination (Join-Path $evidence 'private-logs') -Recurse
  }
} catch {
  # No raw exceptions/paths/credentials in public output.
  $result = @{ scope = 'windows-standard-user'; complete = $false; infrastructurePhase = $phase; hresult = $_.Exception.HResult; cleanup = $false;
    scriptLine = $_.InvocationInfo.ScriptLineNumber; errorType = $_.Exception.GetType().FullName }
  if ($phase -eq 'copy-npm-toolchain') {
    $result.sourcePresent = Test-Path -LiteralPath (Join-Path $nodeRoot 'node_modules/npm')
    $result.destinationPresent = Test-Path -LiteralPath (Join-Path $toolchain 'node_modules')
    $copyText = Get-Content -LiteralPath (Join-Path $evidence 'toolchain-copy-private.log') -Raw -ErrorAction SilentlyContinue
    $result.copyCodes = @([regex]::Matches([string]$copyText, '\b(?:ENOENT|EACCES|EPERM|ENAMETOOLONG|EEXIST|ENOSPC|EINVAL)\b') | ForEach-Object { $_.Value } | Select-Object -Unique)
  }
  [IO.File]::WriteAllText((Join-Path $evidence 'harness-private.log'), ($_ | Out-String))
} finally {
  $cleaned = $true
  if ($created) {
    try {
      # Bound cleanup to processes belonging to the unique disposable SID.
      Get-CimInstance Win32_Process | ForEach-Object {
        $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue
        if ($owner -and $owner.Sid -eq $account.SID.Value) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      }
      $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $account.SID.Value }
      if ($profile) { $profile | Remove-CimInstance }
      Remove-LocalUser -SID $account.SID
      if (Get-LocalUser -SID $account.SID -ErrorAction SilentlyContinue) { throw 'temporary user remains' }
    } catch { $cleaned = $false }
  }
  if ($fixture) {
    try { Remove-Item -LiteralPath $fixture -Recurse -Force } catch { $cleaned = $false }
  }
  if ($password) { $password.Dispose() }
  if ($result -is [Collections.IDictionary]) { $result.cleanup = $cleaned }
  else { $result | Add-Member -NotePropertyName cleanup -NotePropertyValue $cleaned -Force }
  $json = $result | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText((Join-Path $evidence 'standard-user-summary.json'), $json)
  Write-Output 'DODO_STANDARD_USER_BEGIN'
  Write-Output $json
  Write-Output 'DODO_STANDARD_USER_END'
}
if (-not $result.complete -or -not $result.cleanup) { exit 1 }
