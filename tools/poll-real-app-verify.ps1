# Poll for the real-app verification to finish; print summary when done.
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$root = Join-Path $repositoryRoot 'build'
$done = Join-Path $root 'real-app-verify-done.txt'
$deadline = (Get-Date).AddMinutes(9.5)
$lastCount = -1
while ((Get-Date) -lt $deadline) {
  $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  $count = $procs.Count
  if ($count -ne $lastCount) {
    Write-Output ("[{0}] instances: {1}" -f (Get-Date -Format 'HH:mm:ss'), $count)
    $lastCount = $count
  }
  if (Test-Path $done) {
    Write-Output '=== DONE MARKER ==='
    Get-Content $done
    Write-Output '=== RESULT JSON (checks) ==='
    $res = Get-Content (Join-Path $root 'real-app-verify-result.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($res) { $res.checks | ForEach-Object { ("[{0}] {1} :: {2}" -f ($(if ($_.ok) {'PASS'} else {'FAIL'})), $_.name, $_.detail) } }
    exit 0
  }
  Start-Sleep -Seconds 10
}
Write-Output 'POLL TIMEOUT — still no done marker'
$log = Join-Path $root 'real-app-verify.log'
if (Test-Path $log) { Write-Output '--- watcher log tail ---'; Get-Content $log -Tail 8 }
exit 1
