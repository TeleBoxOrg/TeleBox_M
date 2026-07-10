# TeleBox Mtcute 迁移状态追踪

本文件由 mtcute 健康检查 cron 维护。运行逻辑：
1. 读取本文件，找出第一项 `[ ] pending` 任务（按优先级 🔴→🟡→🟢，同优先级按编号）。
2. 立即执行该任务的迁移，用 mtcute 原生 API 改写 teleproto 版实现。
3. 完成后改为 `[x] done` 并提交推送。
4. 全部 done 后进入常规发散性健康检查流程。

> 迁移参考源（只读）：/root/telebox（teleproto 版，TeleBoxOrg/TeleBox）。
> 不要直接复制 teleproto 代码，须用 mtcute 原生 API 改写，确保可编译可运行。

## 🔴 高优先级
- [x] 1. 核心工具类同步 (`src/utils/`) — channelGapBreaker、logger、generationContext、entityHelpers 等大量增强
  - 已完成：逐项对比 teleproto 与 mtcute 各 utils 文件。channelGapBreaker（含指数退避 + 断路器持久化 + MAX_TRACKED_CHANNELS 淘汰，比 teleproto 更完善）、logger（PERSISTENT/HISTORY 降级 + 速率限制 + 上限淘汰，已就位）、generationContext（logger 集成）、entityHelpers（mtcute resolvePeer/forwardMessagesById 原生 API）、apiConfig（safeJsonParse + logger）、loginManager（mtcute client.start 原生登录流）、telegramFormatter/telegraphFormatter/tlRevive/banUtils/conversation 等全部使用 mtcute 原生 API 改写。`tsc --noEmit` 通过（exit 0）。核心工具类同步任务完成。
- [x] 2. 核心插件同步 (`src/plugin/`) — bf、debug、reload、sendLog、status、sudo、sure、tpm、update、ping、prefix、help、alias、re、exec、loglevel
  - 已完成：逐项核验 16 个核心插件。全部已以 mtcute 原生 API 改写并提交（工作树干净，无 teleproto 引用残留）。`tsc --noEmit` 对 `src/plugin/` 无报错；命令处理器集合与 teleproto 版完全一致（alias/exec/help/loglevel/ping/prefix/re/update/sendLog/status/sudo/sure/bf/debug/reload/tpm 逐一 diff 命令表无差异）。mtcute 版相较 teleproto 更优：统一复用 `@utils/htmlEscape`、`@utils/logger`、`@utils/errorHelpers`，`re.ts` 用 `forwardMessagesById` 原生支持论坛话题 `threadId`，`sendLog.ts` 用 `getGlobalClient()` 替代 `msg.client?.sendFile` 直接发文件。核心插件同步任务完成。
- [x] 3. Leech 模块完整迁移 (新增) — leech.ts 插件 + utils/leech/ (json、leechDB、types、structuredLogger、dateRange、targetResolver、messageSerializer、leechService)
  - 已完成：新增 `src/plugin/leech.ts`（mtcute MessageContext API 改写，覆盖 login/session/chat/jobs/stats/db 全部子命令，输出结构化 JSON log）与 `src/utils/leech/` 全套工具类（json 的 safeJsonStringify/bigint 处理、leechDB 的 WAL SQLite + upsert、types、structuredLogger、dateRange、targetResolver 用 getChat 解析 @username/数字ID/t.me 链接/here、messageSerializer 用 mtcute Message 原生字段、leechService 用 getHistory 分页 + GenerationContext 取消 + safeGetMe）。全部以 mtcute 原生 API 改写，无 teleproto 依赖。`tsc --noEmit` 通过（exit 0）。代码已随 commit 7af9ecf 提交本体仓库，本运行仅补齐状态追踪标记。
- [ ] 4. channelGapBreaker 增强同步 — +380 行：指数退避、断路器持久化、teleproto 1.225 兼容、Constructor schema desync 处理
- [ ] 5. logger 增强同步 — PERSISTENT/HISTORY 降级、速率限制、通道间隙处理、全局错误处理器、代理支持
- [ ] 6. TeleBox_Plugins 新增插件迁移 (6个) — fbi、music_hub、auto_sign、codex_image、kitt、netease
- [ ] 7. TeleBox_Plugins 安全修复同步 — exec→execFile 防注入、XSS 转义、缓存限制、清理方法、生命周期管理、FLOOD_WAIT 处理
- [ ] 8. 补充缺失插件 (fbi → TeleBox_M_Plugins) — fbi 仅存在于 TeleBox_Plugins，需完整迁移
- [ ] 9. telebox_mtcute 核心框架同步 — generationContext、pluginManager、runtimeManager、logger 等核心文件

## 🟡 中优先级
- [ ] 10. pluginBase/pluginManager/runtimeManager 同步 — 插件基类清理、管理器错误日志降噪、运行时管理器生命周期修复
- [ ] 11. 其它工具类同步 — loginManager、apiConfig、conversation、banUtils、telegraphFormatter、telegramFormatter 等
- [ ] 12. TeleBox_Plugins 功能修复同步 (18+) — sendat、autodel、quote、zhijiao、lu_bs、aban、speedlink、dig、convert、paolu、qr、eat、clean_member、getstickers、diss、xmsl、oxost、whois、pmcaptcha
- [ ] 13. 插件架构改进同步 — setup() 初始化、cleanup() 生命周期、定时器追踪、generation-safe 模式、空 catch 清理
- [ ] 14. 全局 axios 代理支持 — teleproto 版新增的配置全局代理支持

## 🟢 低优先级
- [ ] 15. 配置文件同步 — package.json、tsconfig.json、ecosystem.config.cjs 等
