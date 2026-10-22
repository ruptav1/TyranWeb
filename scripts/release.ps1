# Makes a release of TyranWeb for GitHub (main/updates.js reads it): after `npx electron-builder --win dir`,
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1
# writes dist/TyranWeb-<version>-win-x64.zip (everything of dist/win-unpacked under TyranWeb/) and its
# SHA-256 beside it (…zip.sha256). Both go up to a GitHub release tagged v<version> of the repository
# named in package.json "updates.github" (the version comes from package.json too: raise it first).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json
$version = $pkg.version
$src = Join-Path $root 'dist\win-unpacked'
if (-not (Test-Path (Join-Path $src 'TyranWeb.exe'))) { throw "Build first: $src\TyranWeb.exe not found" }
$name = "TyranWeb-$version-win-x64.zip"
$dst = Join-Path $root "dist\$name"
$tmp = $dst + '.part'
if (Test-Path $tmp) { Remove-Item $tmp -Force }
$zip = [System.IO.Compression.ZipFile]::Open($tmp, 'Create')
try {
  $base = (Resolve-Path $src).Path.TrimEnd('\') + '\'
  foreach ($f in Get-ChildItem -Path $src -Recurse -File) {
    $rel = $f.FullName.Substring($base.Length).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, 'TyranWeb/' + $rel, 'Optimal') | Out-Null
  }
} finally {
  $zip.Dispose()
}
Move-Item -Force $tmp $dst
$sum = (Get-FileHash -Algorithm SHA256 $dst).Hash.ToLower()
Set-Content -Path "$dst.sha256" -Value "$sum  $name" -Encoding ascii -NoNewline
"$name  $([math]::Round((Get-Item $dst).Length / 1MB, 1)) MB"
"$name.sha256  $sum"
"Release tag: v$version  ->  https://github.com/$($pkg.updates.github)/releases/new"
