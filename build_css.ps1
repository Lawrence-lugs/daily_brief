# One-time (or on-demand) Tailwind build. Output: tailwind.css, which brief.py inlines into each edition.
# The standalone CLI lives outside the vault so Syncthing never syncs it.
$cli = Join-Path $HOME ".config\tailwind\tailwindcss.exe"
if (-not (Test-Path $cli)) {
  New-Item -ItemType Directory -Force (Split-Path $cli) | Out-Null
  Invoke-WebRequest "https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-windows-x64.exe" -OutFile $cli -UseBasicParsing
}
& $cli -i "$PSScriptRoot\tailwind.input.css" -o "$PSScriptRoot\tailwind.css" --minify