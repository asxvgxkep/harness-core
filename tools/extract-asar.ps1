param(
  [string]$AsarPath = $env:HARNESS_CORE_UPSTREAM_ASAR,
  [string]$OutDir
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $repositoryRoot "asar-extracted"
}
if ([string]::IsNullOrWhiteSpace($AsarPath)) {
  throw "No upstream app.asar was provided. Pass -AsarPath <path> or set HARNESS_CORE_UPSTREAM_ASAR."
}
if (-not (Test-Path -LiteralPath $AsarPath -PathType Leaf)) {
  throw "Upstream app.asar was not found at '$AsarPath'. Pass -AsarPath <path> or set HARNESS_CORE_UPSTREAM_ASAR."
}

$b = [System.IO.File]::ReadAllBytes($AsarPath)
# ASAR header layout (Chromium Pickle v2 encoding):
#   [0..3]   uint32 = 4 (size-pickle payload size)
#   [4..7]   uint32 = headerSize (total header pickle length)
#   [8..11]  uint32 = headerSize - 4 (header-pickle payload size)
#   [12..15] uint32 = json length
#   [16..]   json string, padded to 4-byte boundary
$headerSize = [BitConverter]::ToUInt32($b, 4)
$jsonLen    = [BitConverter]::ToUInt32($b, 12)
$jsonStart  = 16
$dataStart  = 8 + $headerSize
Write-Output ("headerSize={0} jsonLen={1} dataStart={2}" -f $headerSize, $jsonLen, $dataStart)

$json = [System.Text.Encoding]::UTF8.GetString($b, $jsonStart, [int]$jsonLen)
$tree = $json | ConvertFrom-Json

$files = New-Object System.Collections.Generic.List[object]

function Walk($dir, $rel) {
  foreach ($prop in $dir.files.PSObject.Properties) {
    $name = $prop.Name
    $entry = $prop.Value
    $childRel = if ($rel -eq "") { $name } else { "$rel/$name" }
    if ($entry.files) {
      Walk $entry $childRel
    } else {
      $files.Add([pscustomobject]@{
        Rel = $childRel
        Size = [long]$entry.size
        Offset = [long]$entry.offset
      })
    }
  }
}

Walk $tree ""

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$total = 0
foreach ($f in $files) {
  $absOff = $dataStart + $f.Offset
  $target = Join-Path $OutDir ($f.Rel -replace '/', '\')
  $dir = Split-Path -Parent $target
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $data = New-Object byte[] $f.Size
  [Array]::Copy($b, $absOff, $data, 0, $f.Size)
  [System.IO.File]::WriteAllBytes($target, $data)
  $total += $f.Size
  Write-Output ("{0}  {1} bytes" -f $f.Rel, $f.Size)
}
Write-Output ("Total extracted: {0} files, {1} bytes" -f $files.Count, $total)
