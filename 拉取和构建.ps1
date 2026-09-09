# 拉取和构建.ps1
# 拉取 MusicFree（你的 GitHub fork）最新代码并构建 Windows 安装包。
#
# 用法:
#   ./拉取和构建.ps1
#       git fetch 默认走 SSH（~/.ssh/config 已把 github.com 重定向到
#       ssh.github.com:443，无需代理）；若 SSH 拉取失败，自动探测本地
#       代理 (localhost:10808)，可用则临时经 https+代理 兜底重试。
#       拉取成功后 merge --ff-only origin/master，再构建安装包。
#   ./拉取和构建.ps1 -NoPull -SkipInstall
#       跳过 fetch/merge，也跳过依赖安装（node_modules 已就绪时用，避免
#       npm ci 清空 node_modules 把编译好的原生模块产物冲掉）。
#   ./拉取和构建.ps1 -AutoInstallInno
#       本机没装 Inno Setup 6 时，自动用 winget 安装（需要网络）。
#
# 说明:
#   - 本脚本是 UNTRACKED 文件 -> `git pull`/merge 不会动它，可放心放仓库内。
#   - 构建本身走 npmmirror（ELECTRON_MIRROR），不依赖 GitHub 代理。
#   - AppId 是安装程序的唯一标识，请保持固定不要换（换了覆盖安装会被
#     Windows 当成两个软件，旧版卸不掉）。
#   - 流程复刻官方 .github/workflows/build.yml 的 build-windows job：
#       装依赖 -> npm run package(forge, 出 out/MusicFree-win32-x64)
#       -> ISCC 编译 release\build-windows.iss -> 重命名 setup.exe
#       -> 建空 portable 目录压缩出绿色版 zip

param(
    [switch]$NoPull,
    [switch]$SkipInstall,
    [switch]$AutoInstallInno,
    [string]$AppId = '2F7A0C3E-6B4D-4A8F-9E21-C5D6B8A0F314'
)

# ---------------------------------------------------------------
# Banner (printed on every run)
# ---------------------------------------------------------------
Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  拉取并构建 MusicFree (Windows)' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  git fetch 走 SSH-443；失败自动兜底本地代理 localhost:10808' -ForegroundColor Gray
Write-Host '  产物: out\MusicFree-<版本>-win32-x64-setup.exe + portable.zip' -ForegroundColor Gray
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------
# Auto-detect proxy availability (TCP probe, same as Orca script)
# Only used as a fallback for git fetch when SSH fails.
# ---------------------------------------------------------------
$proxyUrl  = 'http://localhost:10808'   # 本机全局 git http.proxy 即此端口
$proxyHost = '127.0.0.1'
$proxyPort = 10808

$useProxy = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $iasync = $tcp.BeginConnect($proxyHost, $proxyPort, $null, $null)
    $ok = $iasync.AsyncWaitHandle.WaitOne(1500, $false)
    if ($ok -and $tcp.Connected) { $useProxy = $true }
    $tcp.Close()
} catch { }

if ($useProxy) {
    Write-Host "-> 检测到本地代理可用 ($proxyUrl)，SSH 拉取失败时将自动兜底。" -ForegroundColor Green
} else {
    Write-Host "-> 本地代理 ($proxyUrl) 未启动；仅使用 SSH-443 直连拉取。" -ForegroundColor Yellow
}

$ErrorActionPreference = 'Stop'

# Clear session-injected env vars that can break electron-forge
$env:NODE_OPTIONS          = ''
$env:ELECTRON_RUN_AS_NODE  = ''

# China mirror: electron 二进制从 GitHub 下载会被墙，走 npmmirror
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

# better-sqlite3 原生模块：install 脚本默认从 GitHub Releases 拉预编译包
# （被墙导致 fallback 到 node-gyp 编译）。指向 npmmirror 镜像后直接下载
# 预编译产物，不再需要本地编译 VS 工具链（npm ci 阶段）。
$env:npm_config_better_sqlite3_binary_host = 'https://registry.npmmirror.com/-/binary/better-sqlite3'

# @electron/rebuild（electron-forge package 阶段把 better-sqlite3 重编成
# electron ABI）需要 node-gyp + python。node-gyp 12.3.0 能自动识别 VS 2026
# （versionYear 2026 -> v145，由 package.json overrides 固定）。
# conda py313 不在全局 PATH，显式指给 node-gyp（与 Orca 构建同款配置）。
$condaPython = 'F:\tools\miniconda3\envs\py313\python.exe'
if (Test-Path $condaPython) {
    $env:npm_config_python = $condaPython
    $env:PYTHON            = $condaPython
    Write-Host "-> node-gyp python: $condaPython" -ForegroundColor Gray
} else {
    Write-Warning 'conda py313 python not found at F:\tools\miniconda3\envs\py313\python.exe; better-sqlite3 electron rebuild may fail. Install it or adjust the path in this script.'
}

# Repo root = script location (script lives inside the repo)
$repo = $PSScriptRoot
if ([string]::IsNullOrEmpty($repo)) { $repo = (Get-Location).Path }
Set-Location $repo

# Guard: must be a real project root
if (-not (Test-Path (Join-Path $repo 'package.json'))) {
    Write-Error "Not a MusicFree project root: $repo (package.json not found). Aborting."
    exit 1
}

function Step($name) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
}

# ---------------------------------------------------------------
# Optional: pull latest code
#   - current branch must be master (the tracking branch of origin/master)
#   - merge --ff-only: never rewrites history, never fabricates a merge
#     commit. If you have local commits, it fails loudly instead of
#     mangling them -- rebase yourself in that case.
# ---------------------------------------------------------------
if (-not $NoPull) {
    $branch = git branch --show-current
    if ($branch -ne 'master') {
        Write-Error "Current branch is '$branch', expected 'master'. Switch first: git checkout master"
        exit 1
    }

    # Transfer hardening: avoids mid-pack connection resets
    $hardening = @('-c', 'http.postBuffer=524288000',
                   '-c', 'http.lowSpeedLimit=0',
                   '-c', 'http.lowSpeedTime=999999')

    Step 'fetch origin (SSH-443 direct, fallback to local proxy)'
    $fetched = $false
    for ($i = 1; $i -le 2; $i++) {
        Write-Host "-> git fetch via SSH (attempt $i/2)" -ForegroundColor Gray
        git @hardening fetch origin
        if ($LASTEXITCODE -eq 0) { $fetched = $true; break }
        Start-Sleep -Seconds 2
    }

    # Fallback: SSH failed but a local proxy is listening -> temporary
    # https rewrite for THIS command only (repo config untouched).
    if (-not $fetched -and $useProxy) {
        Write-Host "-> SSH fetch failed; retrying via https through $proxyUrl" -ForegroundColor Yellow
        git @hardening -c "http.proxy=$proxyUrl" -c "https.proxy=$proxyUrl" `
            -c 'url.https://github.com/.insteadOf=git@github.com:' fetch origin
        if ($LASTEXITCODE -eq 0) { $fetched = $true }
    }

    if (-not $fetched) {
        Write-Error 'git fetch failed. Check network / SSH key / proxy, then re-run the script.'
        exit 1
    }

    Step 'fast-forward merge onto origin/master'
    git merge --ff-only origin/master
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'merge --ff-only failed: you have local commits diverging from origin/master. Resolve manually (git rebase origin/master or git merge origin/master), then re-run with -NoPull.'
        exit 1
    }
    Write-Host "-> HEAD: $(git log -1 --format='%h %s')" -ForegroundColor Green
} else {
    Write-Host '-> -NoPull：跳过 fetch + merge，直接构建当前 HEAD。' -ForegroundColor Yellow
}

# ---------------------------------------------------------------
# Version check
# ---------------------------------------------------------------
Step 'version & toolchain'
$version = node -p "require('./package.json').version"
if (-not $version) { Write-Error 'cannot read package.json version'; exit 1 }
Write-Host "-> MusicFree version: v$version"
Write-Host "-> Node: $(node -v)"

# ---------------------------------------------------------------
# Install deps (lockfile-driven)
# ---------------------------------------------------------------
Step 'install dependencies'
if ($SkipInstall) {
    # node_modules 已就绪时跳过：npm ci 会清空 node_modules（连带清掉下一步
    # 编译好的 electron ABI 产物），重复跑既慢又会把修复冲掉。
    Write-Host '-> -SkipInstall：跳过依赖安装，直接使用现有 node_modules。' -ForegroundColor Yellow
} elseif (Test-Path '.\pnpm-lock.yaml') {
    Write-Host '-> pnpm install --frozen-lockfile'
    pnpm install --frozen-lockfile
} elseif (Test-Path '.\package-lock.json') {
    Write-Host '-> npm ci'
    npm ci
} else {
    Write-Host '-> npm install (no lockfile)'
    npm install
}
if (-not $SkipInstall) {
    if ($LASTEXITCODE -ne 0) {
        # npm ci can fail when package.json drifted from the lockfile; retry
        # with plain install before giving up. Same spirit as Orca's retry.
        Write-Host '-> install failed once; retrying with npm install...' -ForegroundColor Yellow
        npm install
    }
    if ($LASTEXITCODE -ne 0) { Write-Error 'dependency install failed'; exit 1 }
}

# ---------------------------------------------------------------
# 预编译 better-sqlite3 到 Electron ABI（绕过 forge rebuild 卡死）
#
# 为什么需要这一步：
#   electron-forge 的 "Preparing native dependencies" 会对原生模块做
#   electron-rebuild。better-sqlite3 12.1.1 在 npmmirror 上只有
#   electron-v121+ 的预编译包，本项目是 Electron 25.3.0 (ABI 116)，没有
#   现成产物 -> 走源码编译；而 @electron/rebuild 的 worker 在下载
#   prebuilt/headers 时会无限等待（无超时），表现为"0 / 1 永久卡住"。
#
# 解决办法：这里提前用 node-gyp 编译好，并写入 forge 的已构建标记
#   build/Release/.forge-meta（内容 "<arch>--<ABI>"）。forge 检测到标记
#   与当前 arch/ABI 匹配就整段跳过 rebuild，不再联网、不再卡死。
#   headers 复用本地缓存 %LOCALAPPDATA%\node-gyp\Cache，全程不联网。
# ---------------------------------------------------------------
Step 'native module: better-sqlite3 (electron ABI)'
$sqliteDir  = Join-Path $repo 'node_modules\better-sqlite3'
$releaseDir = Join-Path $sqliteDir 'build\Release'
if (-not (Test-Path $sqliteDir)) {
    Write-Error "better-sqlite3 not found at $sqliteDir; run without -SkipInstall first."
    exit 1
}

$electronVer = node -p "require('./node_modules/electron/package.json').version"
if (-not $electronVer) { Write-Error 'cannot read electron version'; exit 1 }
$abi = node -e "console.log(require('node-abi').getAbi('$electronVer','electron'))" 2>$null
if (-not $abi) { Write-Error 'cannot resolve electron ABI (node-abi missing?)'; exit 1 }
$arch     = 'x64'
$metaFile = Join-Path $releaseDir '.forge-meta'
$wantMeta = "$arch--$abi"

$needBuild = $true
if ((Test-Path $metaFile) -and (Test-Path (Join-Path $releaseDir 'better_sqlite3.node'))) {
    if (((Get-Content $metaFile -Raw).Trim()) -eq $wantMeta) { $needBuild = $false }
}

if (-not $needBuild) {
    Write-Host "-> 已是 electron $electronVer (ABI $abi) 产物，跳过编译。" -ForegroundColor Green
} else {
    Write-Host "-> 编译 better-sqlite3 for electron $electronVer (ABI $abi)，约 1-3 分钟..." -ForegroundColor Yellow
    $gypCommon = @('--runtime=electron', "--target=$electronVer", "--arch=$arch",
                   '--dist-url=https://www.electronjs.org/headers',
                   "--devdir=$env:LOCALAPPDATA\node-gyp\Cache")
    if (Test-Path $condaPython) { $gypCommon += "--python=$condaPython" }

    Push-Location $sqliteDir
    try {
        & npx node-gyp configure @gypCommon
        if ($LASTEXITCODE -ne 0) { throw 'node-gyp configure failed' }
        & npx node-gyp build @gypCommon
        if ($LASTEXITCODE -ne 0) { throw 'node-gyp build failed' }
    } catch {
        Pop-Location
        $msg = "better-sqlite3 编译失败: $($_.Exception.Message) （若报缺少 python / MSVC，检查上面 python 路径与 VS 2026 安装）"
        Write-Error $msg
        exit 1
    }
    Pop-Location

    if (-not (Test-Path (Join-Path $releaseDir 'better_sqlite3.node'))) {
        Write-Error "编译完成但产物缺失: $releaseDir\better_sqlite3.node"
        exit 1
    }
    # 写 forge 已构建标记（内容必须严格等于 "<arch>--<ABI>"，无换行）
    [System.IO.File]::WriteAllText($metaFile, $wantMeta)
    Write-Host "-> 编译完成，已写入 $metaFile = '$wantMeta'（forge 将跳过 rebuild）" -ForegroundColor Green
}

# ---------------------------------------------------------------
# electron-forge package -> out\MusicFree-win32-x64\MusicFree.exe
# ---------------------------------------------------------------
Step 'electron-forge package'
npm run package
if ($LASTEXITCODE -ne 0) { Write-Error 'npm run package failed'; exit 1 }

$appDir = Join-Path $repo 'out\MusicFree-win32-x64'
if (-not (Test-Path (Join-Path $appDir 'MusicFree.exe'))) {
    Write-Error "package failed: $appDir\MusicFree.exe not found"
    exit 1
}
Write-Host "-> app dir ready: $appDir"

# ---------------------------------------------------------------
# Locate Inno Setup 6 compiler (ISCC.exe)
# ---------------------------------------------------------------
Step 'Inno Setup 6 (ISCC.exe)'
$iscc = $null
$candidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
)
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $iscc = $c; break }
}
if (-not $iscc) {
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { $iscc = $cmd.Source }
}
if (-not $iscc -and $AutoInstallInno) {
    Write-Host '-> Inno Setup missing; installing via winget (JRSoftware.InnoSetup)...'
    winget install --id JRSoftware.InnoSetup -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'winget install of Inno Setup failed. Install manually: https://jrsoftware.org/isdl.php'
        exit 1
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { $iscc = $c; break }
    }
}
if (-not $iscc) {
    Write-Error 'ISCC.exe not found. Install Inno Setup 6 (https://jrsoftware.org/isdl.php), or re-run with -AutoInstallInno.'
    exit 1
}
Write-Host "-> ISCC: $iscc"

# ---------------------------------------------------------------
# Compile release\build-windows.iss -> out\MusicFreeSetup.exe
# ---------------------------------------------------------------
Step 'ISCC compile release\build-windows.iss'
& $iscc '.\release\build-windows.iss' "/DMyAppVersion=$version" "/DMyAppId=$AppId"
if ($LASTEXITCODE -ne 0) { Write-Error "ISCC compile failed (exit=$LASTEXITCODE)"; exit 1 }

$setup = Join-Path $repo 'out\MusicFreeSetup.exe'
if (-not (Test-Path $setup)) { Write-Error "ISCC did not produce $setup"; exit 1 }

# ---------------------------------------------------------------
# Rename to official naming + portable zip
# ---------------------------------------------------------------
$setupName = "MusicFree-$version-win32-x64-setup.exe"
Rename-Item $setup (Join-Path $repo "out\$setupName") -Force
Write-Host "-> installer: out\$setupName"

Step 'generate portable zip'
$portableDir = Join-Path $appDir 'portable'
if (Test-Path $portableDir) { Remove-Item $portableDir -Recurse -Force }
New-Item -ItemType Directory -Path $portableDir -Force | Out-Null

$zipName = "MusicFree-$version-win32-x64-portable.zip"
$zipPath = Join-Path $repo "out\$zipName"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$appDir\*" -DestinationPath $zipPath

Write-Host "`n================ 构建完成 ================" -ForegroundColor Green
Get-ChildItem (Join-Path $repo "out\$setupName"), (Join-Path $repo "out\$zipName") |
    Select-Object Name, @{n = '大小(MB)'; e = { [math]::Round($_.Length / 1MB, 1) } } |
    Format-Table -AutoSize
