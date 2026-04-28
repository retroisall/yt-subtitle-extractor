# resize-store-screenshots.ps1
# 將指定圖片 resize/pad 成 Chrome Store 要求的 1280x800 格式
# 使用方式：
#   ./resize-store-screenshots.ps1 -Input "path/to/screenshot.png" -Output "store-screenshots/01-subtitle.png"
# 或批次處理 store-ready/ 目錄下所有 PNG

param(
    [string]$Input = "",
    [string]$Output = "",
    [switch]$BatchMode = $false
)

Add-Type -AssemblyName System.Drawing

$TARGET_W = 1280
$TARGET_H = 800

function Resize-ToStore {
    param([string]$src, [string]$dst)

    $img = [System.Drawing.Image]::FromFile((Resolve-Path $src))
    $srcW = $img.Width
    $srcH = $img.Height

    # 計算等比例縮放（填滿 1280x800 不變形，不足補黑邊）
    $scaleW = $TARGET_W / $srcW
    $scaleH = $TARGET_H / $srcH
    $scale = [Math]::Min($scaleW, $scaleH)

    $newW = [int]($srcW * $scale)
    $newH = [int]($srcH * $scale)
    $offsetX = [int](($TARGET_W - $newW) / 2)
    $offsetY = [int](($TARGET_H - $newH) / 2)

    $bitmap = New-Object System.Drawing.Bitmap($TARGET_W, $TARGET_H)
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.Clear([System.Drawing.Color]::Black)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, $offsetX, $offsetY, $newW, $newH)
    $g.Dispose()
    $img.Dispose()

    $dstDir = Split-Path $dst -Parent
    if ($dstDir -and -not (Test-Path $dstDir)) {
        New-Item -ItemType Directory -Path $dstDir | Out-Null
    }

    $bitmap.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()

    Write-Host "✓ $src → $dst (${srcW}x${srcH} → ${TARGET_W}x${TARGET_H})"
}

if ($BatchMode) {
    # 批次模式：處理 to-resize/ 目錄下所有 PNG
    $srcDir = "to-resize"
    $dstDir = "store-screenshots"

    if (-not (Test-Path $srcDir)) {
        Write-Host "請建立 'to-resize/' 目錄並放入截圖"
        exit 1
    }

    $files = Get-ChildItem -Path $srcDir -Filter "*.png"
    foreach ($f in $files) {
        $dst = Join-Path $dstDir $f.Name
        Resize-ToStore -src $f.FullName -dst $dst
    }
    Write-Host ""
    Write-Host "完成！輸出至 $dstDir/"
}
elseif ($Input -and $Output) {
    Resize-ToStore -src $Input -dst $Output
}
else {
    Write-Host @"
Chrome Store 截圖 Resize 工具

用法：
  單張：
    .\resize-store-screenshots.ps1 -Input "qa-screenshots/community/tc3-overlay-applied.png" -Output "store-screenshots/01-community.png"

  批次（把截圖放入 to-resize/ 目錄）：
    .\resize-store-screenshots.ps1 -BatchMode

建議的 5 張 Store 截圖：
  01-subtitle-main.png    → YouTube 播放中 + 側邊欄字幕列表
  02-translation.png      → 字幕 + 即時翻譯效果
  03-wordbook.png         → 單字本彈出視窗（點擊單字後）
  04-community.png        → 社群字幕選擇畫面
  05-vocab-dashboard.png  → 詞彙儀表板完整視圖

目標格式：1280x800 PNG（不足補黑邊）
"@
}
