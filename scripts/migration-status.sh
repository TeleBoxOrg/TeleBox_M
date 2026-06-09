#!/bin/bash
# TeleBox mtcute 插件迁移状态检查
cd /root/telebox_mtcute
MIGRATED=$(grep -rLE "from ['\"]teleproto" plugins/*.ts 2>/dev/null | wc -l)
REMAINING=$(grep -rlE "from ['\"]teleproto" plugins/*.ts 2>/dev/null | wc -l)
TSC_ERRORS=$(timeout 120 npx tsc --noEmit 2>&1 | grep "error TS" | wc -l)
echo "📊 TeleBox mtcute 迁移状态:"
echo "  ✅ 已迁移: ${MIGRATED}/121"
echo "  ⏳ 剩余: ${REMAINING}"
echo "  🔴 tsc 错误: ${TSC_ERRORS}"
if [ "$REMAINING" -eq 0 ]; then
  echo "🎉 所有插件迁移完成！"
fi