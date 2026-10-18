#Requires -Version 5.1
<#
.SYNOPSIS
  法飞飞 AI 管理台 · 生成/复用专用受限 SSH 隧道密钥（Windows PowerShell）。

.DESCRIPTION
  只在本机生成密钥并打印后续配置，不连接服务器、不上传任何文件。
  私钥路径：$env:USERPROFILE\.ssh\id_ed25519_fafee_admin

  默认只打印，不修改 ssh config。
  加 -WriteSshConfig：若 ~/.ssh/config 已存在且没有 Host flylegal-admin，
  追加示例 Host 块（HostName 仍是 <服务器IP> 占位符，需要手动替换）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ops\setup-admin-tunnel-key.ps1
  powershell -ExecutionPolicy Bypass -File scripts\ops\setup-admin-tunnel-key.ps1 -WriteSshConfig
#>
[CmdletBinding()]
param(
    [switch]$WriteSshConfig
)

$ErrorActionPreference = 'Stop'

$hostAlias = 'flylegal-admin'
$remotePort = 8791
$hostPlaceholder = '<服务器IP>'

function Stop-WithError {
    param([string]$Message)
    Write-Host "[错误] $Message" -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    Stop-WithError '无法确定用户目录（USERPROFILE 为空）。'
}

$sshDir = Join-Path $env:USERPROFILE '.ssh'
$keyPath = Join-Path $sshDir 'id_ed25519_fafee_admin'
$pubPath = "$keyPath.pub"
$configPath = Join-Path $sshDir 'config'
$utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false

if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    Stop-WithError '未找到 ssh-keygen。请安装 OpenSSH 客户端（设置 → 应用 → 可选功能 → OpenSSH 客户端）。'
}

if (-not (Test-Path -LiteralPath $sshDir)) {
    New-Item -ItemType Directory -Path $sshDir | Out-Null
    Write-Host "已创建目录：$sshDir"
}

$hostShort = if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { 'windows' } else { $env:COMPUTERNAME }
$comment = "fafee-admin-tunnel@$hostShort"

if (Test-Path -LiteralPath $keyPath) {
    Write-Host "已存在专用密钥，直接复用：$keyPath"
} else {
    Write-Host "正在生成专用 SSH 密钥（无口令）：$keyPath"

    # PowerShell 传空字符串给原生程序的引号差异：
    # - Windows PowerShell 5.1 / Legacy 模式需要 '""'，否则空参数会被丢掉；
    # - PowerShell 7.3+ 的 Standard/Windows 模式必须用 ''，否则口令会变成字面量 ""。
    $passingMode = 'Legacy'
    $passingVariable = Get-Variable -Name PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue
    if ($null -ne $passingVariable) {
        $passingMode = [string]$passingVariable.Value
    } elseif ($PSVersionTable.PSVersion -ge [version]'7.3') {
        $passingMode = 'Standard'
    }
    $emptyPassphrase = if ($passingMode -eq 'Legacy') { '""' } else { '' }

    & ssh-keygen -t ed25519 -N $emptyPassphrase -f $keyPath -C $comment
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "ssh-keygen 生成密钥失败（退出码 ${LASTEXITCODE}）。"
    }
}

if (-not (Test-Path -LiteralPath $pubPath)) {
    Write-Host "公钥文件缺失，正在从私钥导出：$pubPath"
    $derived = (& ssh-keygen -y -f $keyPath) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($derived)) {
        Stop-WithError "无法从私钥导出公钥（退出码 ${LASTEXITCODE}）。"
    }
    [System.IO.File]::WriteAllText($pubPath, $derived.Trim() + "`n", $utf8NoBom)
}

$pubKey = ([string](Get-Content -LiteralPath $pubPath -Raw)).Trim()
if ([string]::IsNullOrWhiteSpace($pubKey)) {
    Stop-WithError "公钥文件为空：$pubPath"
}

$authorizedLine = 'restrict,port-forwarding,permitopen="127.0.0.1:' + $remotePort + '" ' + $pubKey

$configBlock = @"
Host $hostAlias
  HostName $hostPlaceholder
  User root
  IdentityFile ~/.ssh/id_ed25519_fafee_admin
  BatchMode yes
  ExitOnForwardFailure yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
"@

Write-Host ''
Write-Host '============================================================'
Write-Host '法飞飞 AI 管理台 · SSH 隧道密钥'
Write-Host '============================================================'
Write-Host ''
Write-Host '[1/3] 本机公钥'
Write-Host $pubKey
Write-Host ''
Write-Host '[2/3] 在服务器 ~/.ssh/authorized_keys 追加下面这一行（保持单行）'
Write-Host $authorizedLine
Write-Host ''
Write-Host '  建议同时确认服务器上的权限：'
Write-Host '    chmod 700 ~/.ssh'
Write-Host '    chmod 600 ~/.ssh/authorized_keys'
Write-Host ''
Write-Host '[3/3] 本机 ssh config 示例（把 <服务器IP> 替换为真实地址）'
Write-Host $configBlock

if ($WriteSshConfig) {
    Write-Host ''
    if (-not (Test-Path -LiteralPath $configPath)) {
        Write-Host "未找到 ${configPath}，未自动写入；请按上面的示例手动创建并替换 <服务器IP>。"
    } else {
        $configText = Get-Content -LiteralPath $configPath -Raw
        if ($configText -cmatch '(?m)^[ \t]*Host[ \t]+([^#]*[ \t])?flylegal-admin([ \t]|\r?$)') {
            Write-Host "${configPath} 中已存在 Host ${hostAlias}，跳过写入（未改动现有配置）。"
        } else {
            $normalizedBlock = $configBlock -replace "`r?`n", "`r`n"
            $blockToWrite = "`r`n# fafee-admin tunnel (added by scripts/ops/setup-admin-tunnel-key.ps1)`r`n" + $normalizedBlock + "`r`n"
            [System.IO.File]::AppendAllText($configPath, $blockToWrite, $utf8NoBom)
            Write-Host "已追加 Host ${hostAlias} 到 ${configPath}。"
            Write-Host '请先把 HostName 的 <服务器IP> 替换为真实地址，再双击 scripts\ops\admin-open.cmd。'
        }
    }
} else {
    Write-Host ''
    Write-Host '如需自动追加上述 Host 块，可重新运行并加上 -WriteSshConfig。'
}

Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 把 [2/3] 的整行追加到服务器 ~/.ssh/authorized_keys；'
Write-Host '  2. 在 ssh config 中配好 Host flylegal-admin（替换 <服务器IP>）；'
Write-Host '  3. 双击 scripts\ops\admin-open.cmd，或运行 npm run admin:open。'
Write-Host ''
Write-Host '私钥只留在本机，不要发给他人、不要提交到仓库，也不要写入服务器。'
