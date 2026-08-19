# ============================================================
# ask-notify-respond.ps1 — Toast 按钮协议处理器
# 由注册表协议 aemeath-approval:// 触发（%1 = 完整 URI）：
#   aemeath-approval://allow?n=<nonce>   /   aemeath-approval://deny?n=<nonce>
# 把决策追加写入 %TEMP%\aemeath-approval.txt（ask-notify.ps1 按 nonce 轮询认领）。
# 注意：本文件无中文内容，无 BOM 也可解析；若加中文注释需保持 UTF-8 BOM。
# ============================================================
param([string]$Uri)

$line = $null
$m = [regex]::Match([string]$Uri, '^aemeath-approval://(allow|deny)\?n=([0-9a-fA-F-]+)$')
if ($m.Success) {
    $decision = $m.Groups[1].Value.ToUpperInvariant()
    $nonce = $m.Groups[2].Value
    $line = "$decision $nonce"
    try {
        Add-Content -Path (Join-Path $env:TEMP 'aemeath-approval.txt') -Value $line -Encoding UTF8
    } catch {
        # 写入失败：结果文件不可达，调用方最终走超时回退，这里静默
    }
}
exit 0
