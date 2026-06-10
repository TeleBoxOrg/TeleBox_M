#!/bin/bash
# TeleBox mtcute 插件迁移状态检查
#
# 迁移进度以【规范插件仓库】为准：/root/TeleBox_Plugins_mtcute/<name>/<name>.ts
# 注意：主仓库 telebox_mtcute/plugins/*.ts 是 .gitignore 的运行时副本（tpm 安装落盘），
#       不能作为迁移进度判据。outdated/ 和 scripts/ 目录不是插件，需排除。

CANONICAL_REPO="/root/TeleBox_Plugins_mtcute"
MAIN_REPO="/root/telebox_mtcute"

cd "$CANONICAL_REPO" || { echo "❌ 找不到规范插件仓库 $CANONICAL_REPO"; exit 1; }

# 顶层插件目录（排除 outdated/ scripts/ node_modules/ 和隐藏目录），每个目录的 <name>/<name>.ts 为规范源
PLUGIN_FILES=$(find . -mindepth 2 -maxdepth 2 -name "*.ts" \
  -not -path "./outdated/*" \
  -not -path "./scripts/*" \
  -not -path "./node_modules/*" \
  -not -path "./.*/*" 2>/dev/null | while read -r f; do
    dir=$(basename "$(dirname "$f")")
    base=$(basename "$f" .ts)
    [ "$dir" = "$base" ] && echo "$f"   # 仅 <name>/<name>.ts
  done)

TOTAL=$(echo "$PLUGIN_FILES" | grep -c . )
REMAINING=$(echo "$PLUGIN_FILES" | xargs grep -lE "from ['\"]teleproto" 2>/dev/null | wc -l)
MIGRATED=$((TOTAL - REMAINING))

# tsc 错误以主仓库为准（规范仓库无 node_modules，借主仓库运行时验证）
TSC_ERRORS=$(cd "$MAIN_REPO" && timeout 200 npx tsc --noEmit 2>&1 | grep -c "error TS")

echo "📊 TeleBox mtcute 迁移状态（口径：规范插件仓库 $CANONICAL_REPO）:"
echo "  ✅ 已迁移: ${MIGRATED}/${TOTAL}"
echo "  ⏳ 剩余 teleproto 引用: ${REMAINING}"
echo "  🔴 telebox_mtcute tsc 错误: ${TSC_ERRORS}"

if [ "$REMAINING" -gt 0 ]; then
  echo ""
  echo "尚未迁移的插件:"
  echo "$PLUGIN_FILES" | xargs grep -lE "from ['\"]teleproto" 2>/dev/null | sed 's#^\./#  - #'
fi

if [ "$REMAINING" -eq 0 ] && [ "$TSC_ERRORS" -eq 0 ]; then
  echo "🎉 所有插件迁移完成，且 tsc 零错误！"
fi
