<#
Uploads the values in .dev.vars to the Cloudflare Pages project as encrypted
production secrets, so nothing is ever typed into the dashboard or committed.

  1. One-off:  npx wrangler login
  2. Fill in .dev.vars (anything left as PASTE_HERE is skipped)
  3. .\tools\push-secrets.ps1 [-Project <pages-project-name>] [-DryRun]

Only the keys in the file are added/updated. Secrets take effect on the NEXT
deployment, so push (or retry the latest deployment) afterwards.
#>
param(
  [string]$Project,
  [string]$File = (Join-Path $PSScriptRoot "..\.dev.vars"),
  [switch]$DryRun
)

if (-not (Test-Path $File)) { throw "Not found: $File" }

$secrets = [ordered]@{}
$skipped = @()
foreach ($line in Get-Content $File) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith("#")) { continue }
  $i = $t.IndexOf("=")
  if ($i -lt 1) { continue }
  $k = $t.Substring(0, $i).Trim()
  $v = $t.Substring($i + 1).Trim()
  if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
    $v = $v.Substring(1, $v.Length - 2)
  }
  if (-not $v -or $v -like "*PASTE_HERE*") { $skipped += $k; continue }
  $secrets[$k] = $v
}

if (-not $secrets.Contains("RESEND_API_KEY")) {
  throw "RESEND_API_KEY is still PASTE_HERE in $File. Paste your Resend key there first."
}
if (-not $secrets.Contains("RESEND_TOPIC_ID")) {
  Write-Warning "RESEND_TOPIC_ID not set: confirmation emails will send, but the 'send me updates' tick will do nothing."
}

Write-Host "Will upload: $($secrets.Keys -join ', ')"
if ($skipped.Count) { Write-Host "Skipping (still PASTE_HERE): $($skipped -join ', ')" }
if ($DryRun) { Write-Host "Dry run: nothing uploaded."; return }

if (-not $Project) {
  Write-Host "`nYour Pages projects:"
  npx --yes wrangler@latest pages project list
  $Project = Read-Host "`nPages project name"
}
if (-not $Project) { throw "A project name is required." }

function Get-SecretNames([string]$p) {
  $out = npx --yes wrangler@latest pages secret list --project-name $p 2>&1 | Out-String
  [regex]::Matches($out, '(?m)^\s*-\s+([A-Za-z0-9_]+)\s*:') | ForEach-Object { $_.Groups[1].Value }
}

$before = @(Get-SecretNames $Project)

# BOM-less JSON: Node's JSON.parse rejects a leading BOM.
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("pages-secrets-" + [guid]::NewGuid().ToString("N") + ".json")
try {
  [IO.File]::WriteAllText($tmp, ($secrets | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  npx --yes wrangler@latest pages secret bulk $tmp --project-name $Project
  if ($LASTEXITCODE -ne 0) { throw "wrangler failed (exit $LASTEXITCODE). If you haven't yet, run: npx wrangler login" }
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

$after = @(Get-SecretNames $Project)
$lost = @($before | Where-Object { $after -notcontains $_ })
if ($lost.Count) { Write-Warning "These secrets existed before but are not listed now: $($lost -join ', '). Re-add them in the Cloudflare dashboard." }

Write-Host "`nDone. Secrets now set: $($after -join ', ')"
Write-Host "They apply to the next deployment: push, or retry the latest deployment in Cloudflare."
