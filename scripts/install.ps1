# OMP Coding Agent Installer for Windows
# Usage: irm https://raw.githubusercontent.com/casepot/oh-my-pi/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/casepot/oh-my-pi/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/casepot/oh-my-pi/main/scripts/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/casepot/oh-my-pi/main/scripts/install.ps1))) -Source -Ref v3.20.1
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/casepot/oh-my-pi/main/scripts/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/casepot/oh-my-pi/main/scripts/install.ps1))) -Binary -Ref v3.20.1

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

$Repo = "casepot/oh-my-pi"
$UpstreamRepo = "can1357/oh-my-pi"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
$SourceDir = if ($env:OMP_SOURCE_DIR) {
    $env:OMP_SOURCE_DIR
} elseif ($env:PI_SOURCE_DIR) {
    $env:PI_SOURCE_DIR
} else {
    Join-Path $env:LOCALAPPDATA "omp\source\oh-my-pi"
}
$BinaryName = "omp-windows-x64.exe"
$DefaultRef = "main"
$MinimumBunVersion = "1.3.14"

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Bun $MinimumVersion or newer is required. Current version: $currentText. Upgrade Bun at https://bun.sh/docs/installation"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Check Git Bash first (most common on Windows)
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    # Check bash.exe on PATH (Cygwin, MSYS2, WSL)
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".omp\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json -AsHashtable
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "✓ Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "⚠ No bash shell found!" -ForegroundColor Yellow
            Write-Host "  OMP requires a bash shell on Windows. Options:" -ForegroundColor Yellow
            Write-Host "    1. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Yellow
            Write-Host "    2. Use WSL, Cygwin, or MSYS2" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  After installing, you can set a custom path in:" -ForegroundColor Yellow
            Write-Host "    $settingsFile" -ForegroundColor Yellow
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Yellow
        }
    } catch {
        Write-Host "⚠ Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    irm bun.sh/install.ps1 | iex
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    Assert-BunVersion $MinimumBunVersion
}

function Assert-CleanSourceCheckout {
    Push-Location $SourceDir
    try {
        $status = git status --porcelain
        if ($status) {
            throw "Source checkout has local changes: $SourceDir`nCommit or stash them before updating."
        }
    } finally {
        Pop-Location
    }
}

function Ensure-Remote {
    param(
        [string]$Name,
        [string]$Url
    )

    Push-Location $SourceDir
    try {
        $current = $null
        try {
            $current = git remote get-url $Name 2>$null
        } catch {
            $current = $null
        }

        if ($current) {
            git remote set-url $Name $Url
        } else {
            git remote add $Name $Url
        }
    } finally {
        Pop-Location
    }
}

function Checkout-SourceRef {
    param([string]$RefToCheckout)

    Push-Location $SourceDir
    try {
        git show-ref --verify --quiet "refs/remotes/origin/$RefToCheckout"
        if ($LASTEXITCODE -eq 0) {
            git checkout -B $RefToCheckout "origin/$RefToCheckout"
        } else {
            git checkout $RefToCheckout
        }
    } finally {
        Pop-Location
    }
}

function Prepare-SourceCheckout {
    param([string]$RefToCheckout)

    $repoUrl = "https://github.com/$Repo.git"
    $upstreamUrl = "https://github.com/$UpstreamRepo.git"
    $gitPath = Join-Path $SourceDir ".git"

    if (Test-Path $gitPath) {
        Assert-CleanSourceCheckout
        Ensure-Remote -Name "origin" -Url $repoUrl
        Ensure-Remote -Name "upstream" -Url $upstreamUrl
    } else {
        if (Test-Path $SourceDir) {
            $firstEntry = Get-ChildItem -LiteralPath $SourceDir -Force | Select-Object -First 1
            if ($firstEntry) {
                throw "Cannot install source checkout into non-empty directory: $SourceDir"
            }
        }

        $parent = Split-Path -Parent $SourceDir
        if ($parent) {
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
        }
        git clone $repoUrl $SourceDir
        Push-Location $SourceDir
        try {
            git remote add upstream $upstreamUrl
        } finally {
            Pop-Location
        }
    }

    Push-Location $SourceDir
    try {
        git fetch --tags origin
        try {
            git fetch --tags upstream
        } catch {
        }
    } finally {
        Pop-Location
    }

    Checkout-SourceRef $RefToCheckout

    if (Test-GitLfsInstalled) {
        Push-Location $SourceDir
        try {
            git lfs pull | Out-Null
        } finally {
            Pop-Location
        }
    }

    $packagePath = Join-Path $SourceDir "packages\coding-agent"
    if (-not (Test-Path $packagePath)) {
        throw "Expected package at $packagePath"
    }
}

function Install-SourceLinks {
    Push-Location $SourceDir
    try {
        bun install
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install source dependencies"
        }

        bun --cwd=packages/coding-agent link
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to link coding-agent package"
        }

        bun --cwd=packages/ai link
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to link ai package"
        }
    } finally {
        Pop-Location
    }
}

function Install-ViaBun {
    Write-Host "Installing via fork source checkout..."
    if (-not (Test-GitInstalled)) {
        throw "git is required for source installs"
    }

    $refToCheckout = if ($Ref) { $Ref } else { $DefaultRef }
    Prepare-SourceCheckout $refToCheckout
    Install-SourceLinks

    Write-Host ""
    Write-Host "✓ Installed omp via fork source checkout" -ForegroundColor Green
    Write-Host "Source: $SourceDir"

    Configure-BashShell

    Write-Host "Run 'omp' to get started!"
}

function Install-Binary {
    if ($Ref) {
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Ref"
        } catch {
            throw "Release tag not found: $Ref`nFor branch/commit installs, use -Source with -Ref."
        }
    } else {
        Write-Host "Fetching latest release..."
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Download binary
    $BinaryUrl = "https://github.com/$Repo/releases/download/$Latest/$BinaryName"
    Write-Host "Downloading $BinaryName..."
    $OutPath = Join-Path $InstallDir "omp.exe"
    Invoke-WebRequest -Uri $BinaryUrl -OutFile $OutPath

    Write-Host ""
    Write-Host "✓ Installed omp to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $needsRestart = $UserPath -notlike "*$InstallDir*"
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    }

    Configure-BashShell

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'omp' to get started!"
    } else {
        Write-Host "Run 'omp' to get started!"
    }
}

# Main logic
if ($Ref -and -not $Source -and -not $Binary) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
} elseif ($Binary) {
    Install-Binary
} else {
    # Default: use bun if available, otherwise binary
    if (Test-BunInstalled) {
        Assert-BunVersion $MinimumBunVersion
        Install-ViaBun
    } else {
        Install-Binary
    }
}
