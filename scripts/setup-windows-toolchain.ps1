#Requires -RunAsAdministrator
<#
  setup-windows-toolchain.ps1
  ---------------------------------------------------------------------------
  One-shot bootstrap for Jojo's code_execute toolchain on Windows.

  Installs every interpreter/compiler that src/tools/code.js knows how to
  call, via winget, so code_execute works across the full language map
  (Python, Node/TS, Go, Rust, JDK, .NET SDK, PHP, Ruby, Perl, plus the
  extras: Kotlin, Dart, Elixir, Julia, Haskell, Zig, Deno, Bun) without
  any further setup.

  USAGE:
    1. Open PowerShell "as Administrator".
    2. If script execution is blocked, run once:
         Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
    3. Run:
         .\setup-windows-toolchain.ps1

  Notes:
    - Safe to re-run: winget skips anything already installed/up to date.
    - Installs machine-wide where possible so a fresh shell picks up PATH
      changes; a terminal restart (or reboot, if Docker Desktop needed WSL2
      enabled) is recommended after this finishes.
    - Some packages (JDK, .NET SDK, Docker Desktop) are large; expect this
      to take a while on first run.
#>

[CmdletBinding()]
param(
  # Skip Docker Desktop (useful on machines where WSL2/Hyper-V isn't wanted).
  [switch]$SkipDocker,
  # Continue past a failed package instead of stopping the whole run.
  [switch]$ContinueOnError
)

$ErrorActionPreference = if ($ContinueOnError) { 'Continue' } else { 'Stop' }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host "This script must be run from an elevated (Administrator) PowerShell prompt." -ForegroundColor Red
  Write-Host "Right-click PowerShell -> 'Run as administrator', then re-run this script." -ForegroundColor Yellow
  exit 1
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Host "winget was not found. Install 'App Installer' from the Microsoft Store, then re-run." -ForegroundColor Red
  exit 1
}

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " Jojo code_execute toolchain bootstrap (winget)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# ── Package list ─────────────────────────────────────────────────────────
# id            = winget package identifier
# label         = friendly name for console output
# codeLanguages = which code.js "language" values this unblocks (informational)
$packages = @(
  @{ id = 'Python.Python.3.12';         label = 'Python 3.12';        codeLanguages = 'python, python3' }
  @{ id = 'OpenJS.NodeJS.LTS';          label = 'Node.js LTS';        codeLanguages = 'javascript, node, typescript (tsx via npx)' }
  @{ id = 'GoLang.Go';                  label = 'Go';                 codeLanguages = 'go' }
  @{ id = 'Rustlang.Rustup';            label = 'Rust (rustup)';      codeLanguages = 'rust' }
  @{ id = 'EclipseAdoptium.Temurin.21.JDK'; label = 'JDK 21 (Temurin)'; codeLanguages = 'java' }
  @{ id = 'Microsoft.DotNet.SDK.8';     label = '.NET SDK 8';         codeLanguages = 'csharp, fsharp (dotnet fsi)' }
  @{ id = 'PHP.PHP.8.3';                label = 'PHP 8.3';            codeLanguages = 'php' }
  @{ id = 'RubyInstallerTeam.Ruby.3.3'; label = 'Ruby 3.3';           codeLanguages = 'ruby' }
  @{ id = 'StrawberryPerl.StrawberryPerl'; label = 'Strawberry Perl'; codeLanguages = 'perl' }
  @{ id = 'Git.Git';                    label = 'Git';                codeLanguages = '(required by several installers/toolchains below)' }
  @{ id = 'Kitware.CMake';              label = 'CMake';              codeLanguages = '(build tooling for c/cpp)' }
  @{ id = 'JetBrains.Kotlin';           label = 'Kotlin';             codeLanguages = 'kotlin' }
  @{ id = 'Dart.SDK';                   label = 'Dart SDK';           codeLanguages = 'dart' }
  @{ id = 'JuliaLang.Julia';            label = 'Julia';              codeLanguages = 'julia' }
  @{ id = 'DenoLand.Deno';              label = 'Deno';               codeLanguages = 'deno' }
  @{ id = 'Oven-sh.Bun';                label = 'Bun';                codeLanguages = 'bun' }
  @{ id = 'zig.zig';                    label = 'Zig';                codeLanguages = 'zig' }
)

if (-not $SkipDocker) {
  $packages += @{ id = 'Docker.DockerDesktop'; label = 'Docker Desktop'; codeLanguages = '(containerized runs / general tooling)' }
}

# VS Code, handy for anyone poking at generated code afterward.
$packages += @{ id = 'Microsoft.VisualStudioCode'; label = 'Visual Studio Code'; codeLanguages = '(editor, not required by code_execute)' }

$results = New-Object System.Collections.Generic.List[object]

foreach ($pkg in $packages) {
  Write-Host ""
  Write-Host "-- Installing $($pkg.label) [$($pkg.id)]" -ForegroundColor Green
  Write-Host "   unlocks: $($pkg.codeLanguages)" -ForegroundColor DarkGray
  try {
    winget install --id $pkg.id --exact --silent `
      --accept-package-agreements --accept-source-agreements `
      --disable-interactivity
    $ok = ($LASTEXITCODE -eq 0)
    $results.Add([pscustomobject]@{ Package = $pkg.label; Id = $pkg.id; Success = $ok })
    if (-not $ok) {
      Write-Host "   (winget exited $LASTEXITCODE — may already be installed, or needs attention)" -ForegroundColor Yellow
    }
  } catch {
    $results.Add([pscustomobject]@{ Package = $pkg.label; Id = $pkg.id; Success = $false })
    Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
    if (-not $ContinueOnError) { throw }
  }
}

# ── Elixir & Haskell ─────────────────────────────────────────────────────
# Neither has a reliably maintained standalone winget package at all times;
# both ship official Windows installers instead. Try winget first, fall
# back to pointing the user at the official installer if it's missing from
# the winget index on this machine.
foreach ($extra in @(
    @{ id = 'Elixir.Elixir'; label = 'Elixir'; fallbackUrl = 'https://elixir-lang.org/install.html#windows'; codeLanguages = 'elixir' }
    @{ id = 'Haskell.GHCup'; label = 'GHCup (Haskell/GHC/runghc)'; fallbackUrl = 'https://www.haskell.org/ghcup/'; codeLanguages = 'haskell' }
  )) {
  Write-Host ""
  Write-Host "-- Installing $($extra.label) [$($extra.id)]" -ForegroundColor Green
  Write-Host "   unlocks: $($extra.codeLanguages)" -ForegroundColor DarkGray
  try {
    winget install --id $extra.id --exact --silent `
      --accept-package-agreements --accept-source-agreements `
      --disable-interactivity
    $ok = ($LASTEXITCODE -eq 0)
    $results.Add([pscustomobject]@{ Package = $extra.label; Id = $extra.id; Success = $ok })
    if (-not $ok) {
      Write-Host "   Not available via winget on this machine. Install manually: $($extra.fallbackUrl)" -ForegroundColor Yellow
    }
  } catch {
    $results.Add([pscustomobject]@{ Package = $extra.label; Id = $extra.id; Success = $false })
    Write-Host "   Not available via winget. Install manually: $($extra.fallbackUrl)" -ForegroundColor Yellow
  }
}

# ── Rust: rustup needs a follow-up to actually install the toolchain ──────
if (Get-Command rustup -ErrorAction SilentlyContinue) {
  Write-Host ""
  Write-Host "-- Finalizing Rust toolchain via rustup" -ForegroundColor Green
  try { & rustup default stable | Out-Null } catch { Write-Host "   rustup default stable failed: $($_.Exception.Message)" -ForegroundColor Yellow }
}

# ── Summary ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " Summary" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
$results | Format-Table -AutoSize

$failed = $results | Where-Object { -not $_.Success }
if ($failed) {
  Write-Host ""
  Write-Host "$($failed.Count) package(s) reported a non-zero exit (often just 'already installed')." -ForegroundColor Yellow
  Write-Host "Re-run this script any time — winget is idempotent." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Close and reopen your terminal (or sign out/in) so PATH updates" -ForegroundColor Cyan
Write-Host "take effect, then re-run Jojo's code_environment_check tool to confirm." -ForegroundColor Cyan
if (-not $SkipDocker) {
  Write-Host "If Docker Desktop was installed and this is its first install, a reboot" -ForegroundColor Cyan
  Write-Host "may be required to finish enabling WSL2/virtualization." -ForegroundColor Cyan
}

