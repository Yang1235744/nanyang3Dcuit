# 打包 nanyang3Dcuit 桌面版为单文件 exe
# 用法（在项目根目录执行）：
#   powershell -ExecutionPolicy Bypass -File desktop\build.ps1
# 产物：dist\Nanyang3Dcuit.exe
# 说明：脚本正文只用 ASCII 字符串，避免 PowerShell 5 把无 BOM 的 UTF-8 按 ANSI 解析而报错。

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$App  = Join-Path $Root 'desktop\app.py'
$Name = 'Nanyang3Dcuit'
$Exe  = Join-Path $Root "dist\$Name.exe"

if (-not (Test-Path $App)) {
    Write-Host "Source not found: $App" -ForegroundColor Red
    exit 1
}

# 预检：只读目录里 PyInstaller 连 .spec 都写不出来，先给出明确提示
$Probe = Join-Path $Root '.build_write_test'
try {
    Set-Content -Path $Probe -Value 'ok' -ErrorAction Stop
    Remove-Item $Probe -Force -ErrorAction SilentlyContinue
} catch {
    Write-Host "Current folder is not writable: $Root" -ForegroundColor Red
    Write-Host "Copy the project to a writable folder (e.g. Desktop) and run build.ps1 again." -ForegroundColor Yellow
    exit 1
}

Set-Location $Root
Write-Host "Project root : $Root"
Write-Host "Building onefile exe, first build may take several minutes ..." -ForegroundColor Cyan

# 优先用当前 python 解释器里的 PyInstaller，避免 PATH 上有多个同名脚本
python -m PyInstaller --noconfirm --onefile --windowed --name $Name $App
if ($LASTEXITCODE -ne 0) {
    Write-Host "PyInstaller failed, exit code: $LASTEXITCODE" -ForegroundColor Red
    Write-Host "Install it first: python -m pip install pyinstaller" -ForegroundColor Yellow
    exit $LASTEXITCODE
}

if (-not (Test-Path $Exe)) {
    Write-Host "Build finished but exe missing: $Exe" -ForegroundColor Red
    exit 1
}

$Info = Get-Item $Exe
$SizeMb = [math]::Round($Info.Length / 1MB, 2)
Write-Host ""
Write-Host "Build OK" -ForegroundColor Green
Write-Host "Exe path : $($Info.FullName)"
Write-Host "Exe size : $SizeMb MB ($($Info.Length) bytes)"
Write-Host "Run it, then fill your API Key in [Settings] at the lower left." -ForegroundColor Cyan
