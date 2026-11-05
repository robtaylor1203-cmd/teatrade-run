<#
Creates (or finds) the "Run updates" Resend Topic with default subscription
OPT-OUT, then writes its id into RESEND_TOPIC_ID in .dev.vars. Opt-out means only
people we explicitly subscribe (donors who tick the box) ever receive run
updates; an opt-in topic would reach every contact in the Resend account.

Needs RESEND_API_KEY in .dev.vars with full access (topics/contacts API).
The key is never printed. Safe to re-run.
#>
param(
  [string]$File = (Join-Path $PSScriptRoot "..\.dev.vars"),
  [string]$TopicName = "Run updates"
)

if (-not (Test-Path $File)) { throw "Not found: $File" }
$text = [IO.File]::ReadAllText($File)

$m = [regex]::Match($text, '(?m)^\s*RESEND_API_KEY\s*=\s*(.+?)\s*$')
$key = if ($m.Success) { $m.Groups[1].Value.Trim('"', "'") } else { "" }
if (-not $key -or $key -like "*PASTE_HERE*") { throw "RESEND_API_KEY is not set in $File" }

$h = @{ Authorization = "Bearer $key" }
function Invoke-Resend($method, $path, $body) {
  try {
    $args = @{ Uri = "https://api.resend.com$path"; Method = $method; Headers = $h; ContentType = "application/json" }
    if ($body) { $args.Body = ($body | ConvertTo-Json) }
    Invoke-RestMethod @args
  } catch {
    $code = [int]$_.Exception.Response.StatusCode
    if ($code -in 401, 403) {
      throw "Resend refused the key (HTTP $code). Create the API key with 'Full access' (a sending-only key can't manage topics or contacts, which the donor emails need)."
    }
    throw "Resend error (HTTP $code) on $method $path"
  }
}

$existing = (Invoke-Resend GET "/topics?limit=100").data | Where-Object { $_.name -eq $TopicName } | Select-Object -First 1
if ($existing) {
  if ($existing.default_subscription -ne "opt_out") {
    throw "A topic named '$TopicName' already exists with default '$($existing.default_subscription)' (cannot be changed). It would email EVERY contact. Delete it in Resend or use a different -TopicName."
  }
  $id = $existing.id
  Write-Host "Found existing topic '$TopicName' (opt-out)."
} else {
  $created = Invoke-Resend POST "/topics" @{
    name                 = $TopicName
    default_subscription = "opt_out"
    description          = "Occasional updates on the Run TeaTrade 190-mile run"
  }
  $id = $created.id
  Write-Host "Created topic '$TopicName' (opt-out)."
}

if ($text -match '(?m)^\s*RESEND_TOPIC_ID\s*=') {
  $text = [regex]::Replace($text, '(?m)^(\s*RESEND_TOPIC_ID\s*=).*$', { param($x) $x.Groups[1].Value + $id })
} else {
  $text = $text.TrimEnd() + "`r`nRESEND_TOPIC_ID=$id`r`n"
}
[IO.File]::WriteAllText($File, $text, (New-Object Text.UTF8Encoding($false)))
Write-Host "Saved RESEND_TOPIC_ID to .dev.vars ($id)."
