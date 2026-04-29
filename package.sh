#!/bin/bash
# 建立 Chrome Store 上架用的乾淨 ZIP 包
# 只包含 manifest.json 宣告的必要檔案，排除所有開發工具

set -e

DIST_DIR="dist-store"
ZIP_NAME="yt-subtitle-store.zip"

echo "=== Chrome Store 打包腳本 ==="
echo ""

# 清理上次產出
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# 複製擴充套件必要檔案
EXTENSION_FILES=(
  "manifest.json"
  "patch.js"
  "inject.js"
  "content.js"
  "styles.css"
  "background.js"
  "firebase.js"
  "editor.html"
  "editor.js"
  "editor.css"
  "vocab-dashboard.html"
  "vocab-dashboard.js"
  "vocab-dashboard.css"
  "banner.png"
)

# 複製 icons 目錄（強制要求）
if [ -d "icons" ]; then
  cp -r icons/ "$DIST_DIR/icons/"
  echo "  ✓ icons/"
else
  echo "  ✗ icons/ (缺失！)"
fi

echo "複製擴充套件檔案..."
for f in "${EXTENSION_FILES[@]}"; do
  if [ -f "$f" ]; then
    cp "$f" "$DIST_DIR/"
    echo "  ✓ $f"
  else
    echo "  ✗ $f (缺失！)"
  fi
done

echo ""
echo "修正正式版 manifest（移除 DEV 標記）..."
# 把 dist-store/manifest.json 的 name 中的 " (DEV)" 移除
sed -i 's/ (DEV)//g' "$DIST_DIR/manifest.json"
grep '"name"' "$DIST_DIR/manifest.json"

echo "打包成 ZIP..."
# Windows 用 PowerShell，Unix/Mac 用 zip
if command -v zip &> /dev/null; then
  cd "$DIST_DIR"
  zip -r "../$ZIP_NAME" . -x "*.DS_Store"
  cd ..
else
  powershell -Command "Compress-Archive -Path '$DIST_DIR\*' -DestinationPath '$ZIP_NAME' -Force"
fi

echo ""
echo "=== 完成 ==="
echo "輸出：$ZIP_NAME"
du -sh "$ZIP_NAME"
echo ""
echo "排除的開發檔案（不進包）："
echo "  relay-server.js, qa_*.js, test_*.mjs, debug_*.mjs"
echo "  landing.html, community-subtitles-page.html, editor-preview.html"
echo "  README.txt, TECHNICAL.md, DESIGN/, notes/, tests/, docs/"
echo "  node_modules/, .git/, .playwright-profile*/"
echo "  firestore.rules, package*.json"
echo ""
echo "上架前請確認："
echo "  1. manifest.json 版本號已更新"
echo "  2. 擴充套件名稱已改為正式名稱（非 'YT Subtitle Demo'）"
echo "  3. icons/ 目錄已建立（16/48/128px PNG）"
echo "  4. 隱私政策 URL 已準備"
echo "  5. kuoway79@gmail.com 已從 background.js 移除或改用 Firestore config"
