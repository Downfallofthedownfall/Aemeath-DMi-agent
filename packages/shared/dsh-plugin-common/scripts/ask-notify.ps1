# ============================================================
# ask-notify.ps1 — 爱弥斯系统审批（Windows Toast 带按钮 + 全局快捷键）
# 用法：先设置环境变量 AEMEATH_ASK_TOOL / AEMEATH_ASK_REASON 再执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File ask-notify.ps1 [-TimeoutSec 120]
# 交互（右下角、不抢焦点、不切窗口）：
#   - Windows Toast 通知，带「允许 / 拒绝」按钮（Outlook 式，按钮走 aemeath-approval://
#     协议激活，由 ask-notify-respond.ps1 写入结果文件）；
#   - 全局快捷键 F5 = 同意，F6 = 拒绝；
#   - 托盘图标常驻（通知消失后仍在），右键菜单 允许/拒绝。
# 输出：ALLOW / DENY / TIMEOUT；调用方按输出决定放行/回退。
# 注意：本文件含中文，必须保持 UTF-8 BOM（PowerShell 5.1 无 BOM 按 GBK 读会解析失败）。
# ============================================================
param([int]$TimeoutSec = 120)

$ErrorActionPreference = 'Stop'

# —— Win32 全局热键（F5=同意 / F6=拒绝）+ 消息窗体（WM_HOTKEY=0x0312）——
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class AskHotKeyForm : Form {
    public event EventHandler AllowPressed;
    public event EventHandler DenyPressed;
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312) {
            int id = m.WParam.ToInt32();
            if (id == 1) {
                if (AllowPressed != null) AllowPressed(this, EventArgs.Empty);
            } else if (id == 2) {
                if (DenyPressed != null) DenyPressed(this, EventArgs.Empty);
            }
        }
        base.WndProc(ref m);
    }
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
"@ -ReferencedAssemblies System.Windows.Forms

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$tool = $env:AEMEATH_ASK_TOOL
$reason = $env:AEMEATH_ASK_REASON
if ([string]::IsNullOrEmpty($tool)) { $tool = '未知工具' }
if ([string]::IsNullOrEmpty($reason)) { $reason = '' }

# —— 本地化（AEMEATH_ASK_LOCALE：zh/en，缺省 zh）——
$locale = $env:AEMEATH_ASK_LOCALE
if ($locale -eq 'en') {
    $uiTitle   = 'Aemeath · Permission Request'
    $uiHint    = 'F5 approve / F6 reject, or use the buttons below'
    $uiAllow   = 'Approve'
    $uiDeny    = 'Reject'
    $uiBalloon = "Calling: $tool — F5 approve / F6 reject"
    $uiHotkeyHint = ' (F5/F6 in use — click a button or the tray icon)'
} else {
    $uiTitle   = '爱弥斯 · 权限确认'
    $uiHint    = 'F5 同意 / F6 拒绝，或点下方按钮'
    $uiAllow   = '允许'
    $uiDeny    = '拒绝'
    $uiBalloon = "调用：$tool — F5 同意 / F6 拒绝"
    $uiHotkeyHint = '（F5/F6 热键被占用，请点按钮或托盘）'
}

# —— 本请求唯一 nonce（结果文件按 nonce 认领，并发/旧记录互不干扰）——
$nonce = [guid]::NewGuid().ToString()
$resultFile = Join-Path $env:TEMP 'aemeath-approval.txt'

# —— 隐藏热键窗口（保留句柄接收 WM_HOTKEY）——
$form = New-Object AskHotKeyForm
$form.ShowInTaskbar = $false
$form.FormBorderStyle = 'None'
$form.Opacity = 0
$form.Width = 1
$form.Height = 1
$form.Show()

# MOD_NOREPEAT=0x4000（防按住连发）；VK 0x74='F5' 0x75='F6'
$hkAllow = [AskHotKeyForm]::RegisterHotKey($form.Handle, 1, 0x4000, 0x74)
$hkDeny  = [AskHotKeyForm]::RegisterHotKey($form.Handle, 2, 0x4000, 0x75)

# —— 注册 aemeath-approval:// 协议（HKCU 用户级，一次即可；失败仅按钮不可用）——
try {
    $proto = 'HKCU:\Software\Classes\aemeath-approval'
    if (-not (Test-Path "$proto\shell\open\command")) {
        New-Item -Path "$proto\shell\open\command" -Force | Out-Null
        $responder = Join-Path $PSScriptRoot 'ask-notify-respond.ps1'
        $cmd = '"powershell.exe" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $responder + '" "%1"'
        Set-ItemProperty -Path "$proto\shell\open\command" -Name '(default)' -Value $cmd
    }
} catch {
    # 注册失败：Toast 按钮退化为不可点，F5/F6 与托盘仍可用
}

# —— 右下角 Toast（带允许/拒绝按钮；XML 特殊字符转义）——
function Esc-Xml([string]$s) {
    return [System.Security.SecurityElement]::Escape([string]$s)
}
$toolEsc = Esc-Xml $tool
$uiTitleEsc = Esc-Xml $uiTitle
$uiAllowEsc = Esc-Xml $uiAllow
$uiDenyEsc = Esc-Xml $uiDeny
$toastXml = @"
<toast activationType="protocol" launch="aemeath-approval://timeout?n=$nonce">
  <visual><binding template="ToastText02">
    <text id="1">$uiTitleEsc</text>
    <text id="2">$toolEsc — $uiHint</text>
  </binding></visual>
  <actions>
    <action content="$uiAllowEsc" arguments="aemeath-approval://allow?n=$nonce" activationType="protocol"/>
    <action content="$uiDenyEsc" arguments="aemeath-approval://deny?n=$nonce" activationType="protocol"/>
  </actions>
</toast>
"@

$toastShown = $false
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
    $xmlDoc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xmlDoc.LoadXml($toastXml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xmlDoc
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Aemeath.DmiAgent')
    $notifier.Show($toast)
    $toastShown = $true
} catch {
    Write-Warning "Toast 显示失败（回退气泡）：$($_.Exception.Message)"
    $toastShown = $false
}

# —— 托盘图标（兜底：toast 失败时弹气泡；通知消失后常驻可右键）——
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Information
$ni.Visible = $true
$ni.Text = $uiTitle

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$allowItem = $menu.Items.Add($uiAllow)
$denyItem = $menu.Items.Add($uiDeny)
$ni.ContextMenuStrip = $menu

$hotkeyHint = ''
if (-not $hkAllow -or -not $hkDeny) {
    $hotkeyHint = $uiHotkeyHint
}
$ni.BalloonTipTitle = $uiTitle
$ni.BalloonTipText = "$uiBalloon$hotkeyHint"
$ni.BalloonTipIcon = 'Info'

# —— 决策（任意来源先到先得）——
$script:result = $null
$allowAction = { $script:result = 'ALLOW' }
$denyAction  = { $script:result = 'DENY' }
$form.Add_AllowPressed($allowAction)
$form.Add_DenyPressed($denyAction)
$ni.add_BalloonTipClicked($allowAction)
$allowItem.add_Click($allowAction)
$denyItem.add_Click($denyAction)

if (-not $toastShown) { $ni.ShowBalloonTip(10000) }

# —— 消息泵 + 结果文件轮询（Toast 按钮经协议写文件）——
$deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
while ($null -eq $script:result -and [DateTime]::Now -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    if (Test-Path $resultFile) {
        foreach ($line in @(Get-Content $resultFile -ErrorAction SilentlyContinue)) {
            if ($line -match "^ALLOW $nonce$") { $script:result = 'ALLOW'; break }
            if ($line -match "^DENY $nonce$") { $script:result = 'DENY'; break }
        }
    }
    Start-Sleep -Milliseconds 200
}
if ($null -eq $script:result) { $script:result = 'TIMEOUT' }

# —— 清理 ——
$ni.Visible = $false
$ni.Dispose()
$menu.Dispose()
[AskHotKeyForm]::UnregisterHotKey($form.Handle, 1) | Out-Null
[AskHotKeyForm]::UnregisterHotKey($form.Handle, 2) | Out-Null
$form.Close()
$form.Dispose()

Write-Output $script:result
exit 0
