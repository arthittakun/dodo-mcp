# Runs under the temporary standard user's real logon and loaded profile.
$ErrorActionPreference = 'Stop'
try {
  $plan = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'plan.json') -Raw | ConvertFrom-Json
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($admin -or $identity.User.Value -ne $plan.expectedSid) { throw 'not the requested standard user' }
  $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
  $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
  $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
  $env:USERNAME = $identity.Name.Split('\')[-1]
  $env:USERDOMAIN = $env:COMPUTERNAME
  $env:HOME = $env:USERPROFILE
  if (-not $env:USERPROFILE -or -not $env:LOCALAPPDATA) { throw 'profile not loaded' }
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'identity.json'), (@{ administrator = $admin; expectedUser = $true; profileLoaded = $true } | ConvertTo-Json -Compress))
  & $plan.node (Join-Path $PSScriptRoot 'windows-standard-user-child.mjs')
  exit $LASTEXITCODE
} catch {
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'result.json'), (@{ scope = 'windows-standard-user'; complete = $false; infrastructurePhase = 'standard-user-profile'; hresult = $_.Exception.HResult } | ConvertTo-Json -Compress))
  exit 1
}
