# Jarvis Companion installer (Windows, no admin needed)
#   irm https://openjarvis-hud.vercel.app/companion/install.ps1 | iex
#
# What it does:
#   1. Finds Python 3 (installs Python 3.13 with winget if missing)
#   2. Downloads jarvis_companion.py to %LOCALAPPDATA%\JarvisCompanion
#   3. Registers it to start in the background whenever you sign in (per-user, no admin)
#   4. Starts it now and checks it answers on http://127.0.0.1:8765
#
# Uninstall: Remove-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run JarvisCompanion
#            (and/or delete "Jarvis Companion.lnk" from shell:startup), then delete %LOCALAPPDATA%\JarvisCompanion

# Everything runs inside a script block so settings like $ErrorActionPreference
# do not leak into the user's PowerShell window (irm | iex runs in the caller's scope).
& {
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

    # Start automatically at sign-in (no admin needed).
    # 1st choice: per-user Run registry key. Fallback: Startup folder shortcut.
    # (Windows Security "Controlled folder access" or antivirus can block the Startup folder.)
    $script = Join-Path $Dir 'jarvis_companion.py'
    $autostart = $false
    try {
        Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'JarvisCompanion' -Value ('"' + $pyw + '" "' + $script + '"') -ErrorAction Stop
        $autostart = $true
    } catch {
        try {
            $startup = [Environment]::GetFolderPath('Startup')
            $ws = New-Object -ComObject WScript.Shell
            $lnk = $ws.CreateShortcut((Join-Path $startup 'Jarvis Companion.lnk'))
            $lnk.TargetPath = $pyw
            $lnk.Arguments = '"' + $script + '"'
            $lnk.WorkingDirectory = $Dir
            $lnk.WindowStyle = 7
            $lnk.Description = 'Jarvis Companion - web search and scheduled tasks for your local Jarvis'
            $lnk.Save()
            $autostart = $true
        } catch {}
    }
    if ($autostart) { Ok 'Will start automatically every time you sign in to Windows' }
    else {
        Write-Host '[ warn ] Your security settings blocked automatic start. Jarvis Companion will run now.' -ForegroundColor Yellow
        Write-Host '         To start it with Windows: Win+R -> shell:startup -> right-click -> New -> Shortcut, and paste:' -ForegroundColor Yellow
        Write-Host ('         "' + $pyw + '" "' + $script + '"') -ForegroundColor Yellow
    }

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
        Write-Host 'Next: reload the Jarvis website. If this is a new install, open SETUP -> COMPANION and paste your search API key.' -ForegroundColor Yellow
    } else {
        Fail "Companion did not start. See $Dir\companion.log"
    }
}
