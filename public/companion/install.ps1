# Jarvis Companion installer (Windows, no admin needed)
#   irm https://openjarvis-hud.vercel.app/companion/install.ps1 | iex
#
# What it does:
#   1. Finds Python 3 (installs Python 3.13 with winget if missing)
#   2. Downloads jarvis_companion.py to %LOCALAPPDATA%\JarvisCompanion
#   3. Adds a shortcut to your Startup folder so it runs in the background whenever you sign in
#   4. Starts it now and checks it answers on http://127.0.0.1:8765
#
# Uninstall: delete "Jarvis Companion.lnk" from shell:startup and the folder %LOCALAPPDATA%\JarvisCompanion

$ErrorActionPreference = 'Stop'
$Site = 'https://openjarvis-hud.vercel.app'
$Dir  = Join-Path $env:LOCALAPPDATA 'JarvisCompanion'

function Info($m) { Write-Host "[jarvis] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[  ok  ] $m" -ForegroundColor Green }
function Fail($m) { Write-Host "[ fail ] $m" -ForegroundColor Red; throw $m }

function Find-Pythonw {
    $cands = @()
    $root = Join-Path $env:LOCALAPPDATA 'Programs\Python'
    if (Test-Path $root) { $cands += Get-ChildItem $root -Directory -Filter 'Python3*' | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'pythonw.exe' } }
    foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($pf -and (Test-Path (Join-Path $pf 'Python*'))) { $cands += Get-ChildItem $pf -Directory -Filter 'Python3*' | ForEach-Object { Join-Path $_.FullName 'pythonw.exe' } }
    }
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        try { $exe = & $py.Source -3 -c "import sys;print(sys.executable)" 2>$null; if ($exe) { $cands += (Join-Path (Split-Path $exe) 'pythonw.exe') } } catch {}
    }
    foreach ($c in $cands) { if ($c -and (Test-Path $c) -and ($c -notlike '*WindowsApps*')) { return $c } }
    return $null
}

Info 'Looking for Python...'
$pyw = Find-Pythonw
if (-not $pyw) {
    Info 'Python not found - installing Python 3.13 with winget (a few minutes)...'
    winget install --id Python.Python.3.13 --silent --accept-source-agreements --accept-package-agreements | Out-Null
    $pyw = Find-Pythonw
    if (-not $pyw) { Fail 'Python install did not complete. Close PowerShell, open a new one and run this installer again.' }
}
Ok "Python: $pyw"

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Info 'Downloading Jarvis Companion...'
Invoke-WebRequest -UseBasicParsing -Uri "$Site/companion/jarvis_companion.py" -OutFile (Join-Path $Dir 'jarvis_companion.py')
Ok "Saved to $Dir"

# Stop an older copy if it is running
Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*jarvis_companion.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Start automatically at sign-in (Startup folder shortcut, no admin needed)
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Jarvis Companion.lnk'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $pyw
$lnk.Arguments = '"' + (Join-Path $Dir 'jarvis_companion.py') + '"'
$lnk.WorkingDirectory = $Dir
$lnk.WindowStyle = 7
$lnk.Description = 'Jarvis Companion - web search and scheduled tasks for your local Jarvis'
$lnk.Save()
Ok 'Will start automatically every time you sign in to Windows'

Info 'Starting Jarvis Companion...'
Start-Process -FilePath $pyw -ArgumentList ('"' + (Join-Path $Dir 'jarvis_companion.py') + '"') -WorkingDirectory $Dir -WindowStyle Hidden
$up = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2; if ($h.ok) { $up = $true; break } } catch {}
}
if ($up) {
    Ok "Jarvis Companion $($h.version) is running on http://127.0.0.1:8765"
    Write-Host ''
    Write-Host 'Next: open the Jarvis website -> SETUP -> COMPANION and paste your search API key.' -ForegroundColor Yellow
} else {
    Fail "Companion did not start. See $Dir\companion.log"
}
