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
- [x] 4. channelGapBreaker 增强同步 — +380 行：指数退避、断路器持久化、teleproto 1.225 兼容、Constructor schema desync 处理
  - 已完成：经对比 teleproto 版 channelGapBreaker.ts，mtcute 版此前已含指数退避、1.225 updateManager 布局支持、Constructor schema desync 识别与冷却期内静默重清 pts。本次补齐 teleproto 最近一次增强（commit 428f632：有界驱逐防止 channelFailures Map 无限增长）：补定义此前缺失的 `MAX_TRACKED_CHANNELS`(500) 与 `EVICTION_MIN_AGE_MS`(2h) 常量，新增 `evictStaleRecords()` 并在 `recordChannelGapFailure` 达到上限时主动驱逐空闲记录（保留活跃故障/断路器/已升级的退避冷却）。同时把 logger.ts `extractChannelId` 同步 teleproto 新增的 `fetching difference for <id>` 与通用 `updates (\d{8,})` 提取模式（替换原先仅匹配行尾的 `WRN updates`）。`tsc --noEmit` 通过（exit 0）。
- [x] 5. logger 增强同步 — PERSISTENT/HISTORY 降级、速率限制、通道间隙处理、全局错误处理器、代理支持
  - 已完成：对比 teleproto 版 logger.ts，mtcute 版此前已包含 PERSISTENT/HISTORY 降级、5 分钟/通道速率限制、downgradeLastLogged 有界驱逐、通道间隙断路器处理（channelId 提取已补齐 `fetching difference for <id>` 与 `updates (\d{8,})` 模式，比 teleproto 更新）。本次补齐 teleproto 在 logger 之外的两项增强：`src/index.ts` (1) 新增全局 axios 代理支持（读取 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 环境变量，parseProxy 后写入 axios.defaults.proxy），(2) 全局错误处理器改从 `process.exit(1)` 退出改为只记录 `logger.error` 不退出——避免单个未捕获 rejection 直接崩溃整个进程（对齐 teleproto commit 47d0798）。`tsc --noEmit` 通过（exit 0）。
- [x] 6. TeleBox_Plugins 新增插件迁移 (6个) — fbi、music_hub、auto_sign、codex_image、kitt、netease
  - 已完成：6 个插件中 music_hub、codex_image、kitt、netease 此前已是 mtcute 原生版（无 teleproto 引用，tsc 通过）。本次补齐缺失的两个：
    - `fbi`：teleproto 源在 /root/TeleBox_Plugins/fbi/fbi.ts（仅存在于 teleproto 插件仓库）。用 mtcute 原生 API 完整改写后新增至 TeleBox_M_Plugins/fbi/fbi.ts：`getDialogs`→`client.iterDialogs` 异步迭代、`iterMessages`→`client.getHistory`、`getEntity`→`client.getChat`、`msg.edit/sendMessage`→`msg.edit`/`client.sendText`+`client.editMessage({chatId,message})`、`deleteMessages`→`client.deleteMessagesById`、`Api.Message`→mtcute `MessageContext`/`Chat`/`User`；XSS 转义改用 `@utils/htmlEscape`；复用 `safeGetReplyMessage`、`getGlobalClient`、logger；保留 `setup()` 初始化 DB 与 `cleanup()` 定时器清理（防 reload 泄漏）。`tsc --noEmit` 对 6 个插件全部通过（exit 0）。
    - `auto_sign`（自动签到）：其 teleproto 对应实现为 `checkin/checkin.ts`（commit a909490「自动签到插件 (#240)」），该 mtcute 版 `checkin/checkin.ts` 此前已存在并迁移完成，命令为 `.qd`。故 6 个新增插件全部就位。
- [x] 7. TeleBox_Plugins 安全修复同步 — exec→execFile 防注入、XSS 转义、缓存限制、清理方法、生命周期管理、FLOOD_WAIT 处理
  - 已完成（核心命令注入修复）：对比 teleproto 版安全修复提交（2053f03 yt-dlp、c504b74 tts/t、c0c751b openlist、62c206c convert、2c5301d gif、05fdb33 speedlink、417e562 dig/service、1edb3bd qr），将 mtcute 插件仓库中所有「用户输入流入 shell 字符串」的 `exec()` 调用改写为 `execFile()` + 参数数组（shell:false，无 shell 插值），从根本上杜绝命令注入：
    - `audio_to_voice/audio_to_voice.ts`：`exec`→`execFile`，ffmpeg 转码参数改为数组。
    - `t/t.ts`：`generateMusic`（用户提供 title/artist/album 经 ffmpeg -metadata 注入）与 `generateSpeechSimple` 全部改用 `execFileAsync("ffmpeg", [...], { shell: false })` 参数数组。
    - `yt-dlp/yt-dlp.ts`：版本检测、搜索查询、主下载命令（finalSearchQuery/title/artist/album 均由用户输入或 AI 解析）全部改为 `execFilePromise(YTDLP_PATH, [...])`，删除原先脆弱的手工引号转义。
    - 已验证 convert、speedlink、gif、qr、dig、service 此前在 mtcute 版已使用 execFile/spawn 参数数组，毋需改动。
    - 经 `tsc --noEmit` 对三个改动文件类型检查通过（无错误）。
  - 说明：缓存限制 / cleanup() / 生命周期 / FLOOD_WAIT 类修复（teleproto 82ed0e3 eat/clean_member、b1d1f51 quote、a9de9a1 aban、1fa... paolu、798c0d2 lifecycle 等）主要落在任务 #12/#13（功能修复 / 架构改进）范畴，本任务聚焦最高危的命令注入，已同步完成。
- [x] 8. 补充缺失插件 (fbi → TeleBox_M_Plugins) — fbi 仅存在于 TeleBox_Plugins，需完整迁移
  - 已完成：随任务 #6 一并完成。fbi 已用 mtcute 原生 API 改写并新增至 TeleBox_M_Plugins/fbi/fbi.ts，`tsc --noEmit` 通过。
- [x] 9. telebox_mtcute 核心框架同步 — generationContext、pluginManager、runtimeManager、logger 等核心文件
  - 已完成：逐项对比 teleproto 与 mtcute 四个核心文件。`generationContext.ts` 与 `pluginManager.ts` 此前已用 mtcute 原生 API（logger、Dispatcher、Proxy 别名、并行 setup）改写，且比 teleproto 更完善（console.* → logger、teleproto 事件 → mtcute Dispatcher）。`logger.ts` 此前已含 PERSISTENT/HISTORY 降级、速率限制、有界驱逐、通道间隙断路器（比 teleproto 更新），无需改动。
  - 唯一缺失项：`runtimeManager.ts` 的**连接断开看门狗**（客户端持续离线 30s 后自动整代 runtime 重载，teleproto 版在 buildRuntime 中通过 gramjs `UpdateConnectionState` 事件实现）。mtcute 无该事件类，改用 mtcute 原生 `client.onConnectionState`（`Emitter<ConnectionState>`，状态 offline/connecting/updating/connected）改写：offline 时安排 30s 后 `reloadRuntime()`，connected 时取消；并通过 `context.trackDisposable` 在卸载时 `.remove()` 监听器并清除定时器，防止 reload 泄漏。随 commit 86a9be2 提交本体仓库。`tsc --noEmit` 对 runtimeManager 无新增报错（本体其余 agent.ts 既有报错与本任务无关，已确认在干净工作树下同样存在）。核心框架同步任务完成。

## 🟡 中优先级
- [x] 10. pluginBase/pluginManager/runtimeManager 同步 — 插件基类清理、管理器错误日志降噪、运行时管理器生命周期修复
  - 已完成：逐项对比 teleproto 近 30 次提交（含 287bb87 命令行 env 容错、ef2f77c 去 any、565e2a2 无限重连看门狗、a328e24 去冗余 abort、247ad51 setup 隔离、8cfe4c1 错误日志降噪等），mtcute 版三文件已完全对齐：pluginBase 用 logger + safeJsonParse（无 teleproto 引用残留）；pluginManager 对缺失模块降为 logger.debug（降噪）、setup 失败用 Promise.all + try/catch 隔离（后续插件仍初始化）；runtimeManager 用 mtcute 原生 client.onConnectionState 实现断开看门狗、trackDisposable 清理监听器与定时器防泄漏、reloadRuntime 不再冗余 abort（由 unloadPluginsForRuntime 守卫）。唯一未改项：Plugin.cmdHandlers 第二参数 `trigger?: any` 保留——收窄为 MessageContext 会使 .gitignore 下的用户插件 weather.ts（用 `args: string[]`）`tsc` 失败，且 teleproto 上游 ef2f77c 也刻意保留该 any；故维持现状保证跨插件兼容与构建通过。`tsc --noEmit` 对三文件无新增报错。任务 #10 完成。
- [x] 11. 其它工具类同步 — loginManager、apiConfig、conversation、banUtils、telegraphFormatter、telegramFormatter 等
  - 已完成：逐项对比 teleproto 与 mtcute 的 6 个命名工具类（loginManager、apiConfig、conversation、banUtils、telegraphFormatter、telegramFormatter）及 authGuards。
    - loginManager（mtcute 用 `client.start()` + SQLite 存储，`startUpdatesLoop` 修复）、apiConfig（`safeJsonParse` + logger + `LegacyProxyConfig` 类型替代 `any`）、conversation（mtcute 原生 `Conversation` 类封装）、telegraphFormatter/telegramFormatter（logger 集成 + URL 校验错误日志）、authGuards（`getMe()` 直接返回 `User`，无 teleproto `Api.User` 残留）已全部以 mtcute 原生 API 改写，且比 teleproto 更优（类型收窄、`console.*`→logger）。
    - **修复一处真实迁移 bug**：`banUtils.getBannedUsers` 先前机械照搬 teleproto `ChannelParticipantBanned` 的字段形状，访问 `member.peer.userId` / `member.kickedBy` / `member.date`，但 mtcute 的 `ChatMember` 对象根本没有这些字段（实体封在 `member.user` 访问器、封禁者经 `member.restrictedBy`、时间在 `member.raw.date`），导致该判定恒为 false、函数永远返回空数组。已改为 mtcute 原生访问：`member.user` + `member.restrictedBy` + `(member.raw as {date?}).date`，并修正 `username`/`title` 的 `string|null`→`string|undefined` 类型。`tsc --noEmit` 对 banUtils.ts 无报错。
  - 任务 #11 完成。
- [ ] 12. TeleBox_Plugins 功能修复同步 (18+) — sendat、autodel、quote、zhijiao、lu_bs、aban、speedlink、dig、convert、paolu、qr、eat、clean_member、getstickers、diss、xmsl、oxost、whois、pmcaptcha
  - 进度：逐项对比 teleproto 版对应插件，针对 mtcute 版的迁移缺陷进行修复。
    - [x] sendat（已提交 TeleBox_M_Plugins d320ff6）：修复致命 bug——executeTask 误用 `client.sendText(task.cid, "")` 导致定时任务永远发送空消息，改为 `client.sendText(task.cid, html(task.msg))`；补充注册 cron 前的 zombie 守卫（删除上一代同名 cron）；新增 `cleanup()` 钩子清除本插件 cron 任务防 reload 泄漏。对齐 teleproto 版 sendat.ts。
    - [x] autodel（本轮提交）：修复 reload 后静默失效的真实迁移 bug——`setup()` 仅赋值 `lifecycle` 而未重新初始化数据库。teleproto 版在 `setup()` 中当 `this.db` 为 null 时调用 `initDatabase()`（因 `cleanup()` 在每次 reload 时把 `this.db` 置 null 并清空 `this.settings`，若不在 load 时重建，`.reload` 后 autodel 因 db 为 null、settings 为空而彻底停止工作，直到整进程重启）。mtcute 版此前缺失该重建逻辑，本次将 `setup()` 改为 `async` 并在 `!this.db` 时 `await this.initDatabase()`，同时保留 teleproto 版一致的 `deleteMessagesById(msg.chat.inputPeer, [msg.id], { revoke: false })`（mtcute Chat 确有 `inputPeer` getter，类型正确）。`tsc --noEmit` 对 autodel 无新增报错。
    - [x] quote（已提交 TeleBox_M_Plugins a959250）：对比 teleproto 版发现 mtcute 版有两处功能缺口并已修复——(1) `getQuoteGen()` 缺失运行时按需安装的 vendor npm 依赖（telegraf/lru-cache/runes/jimp/smartcrop-sharp/emoji-db）且 `QUOTE_DEP_FILES` 漏列 `generate.js`，导致首次 `require('./quote/generate')` 会因依赖未安装报 MODULE_NOT_FOUND 而崩溃；已补齐 `QUOTE_VENDOR_NPM_DEPS` 安装循环与 `generate.js` 依赖项。(2) 缺失 teleproto 版在任务 #7 之后补的 RPC 悬挂保护——未对 MTProto RPC（getHistory/getReply/edit/reply/sendMedia/delete）及整条管线加超时，连接断开时命令会永久挂起无响应；已同步引入 `withTimeout`/`QuoteTimeoutError`（20s/90s 预算）包裹全部 RPC 与 pipeline。另修正 `collectMessages` 正向翻页误用 `redive: true`（mtcute 无此选项，正确为 `reverse: true`）的真实 bug。`tsc --noEmit` 对 quote 及全仓均 0 报错。
    - [x] zhijiao（已提交 TeleBox_M_Plugins b0ac416）：对比 teleproto 版 zhijiao.ts，mtcute 版功能一致（无功能性 bug）。本次把本地 `plugins/zhijiao.ts` 的改进（此前已本地化、未入库）反向同步进插件仓库：`getInterpretation` 中 three 组 keyword 评分代码（positiveScore/cautionScore/waitingScore 全部被计算却从未使用，纯冗余）删除；本地重复的 `htmlEscape` 改为复用共享的 `@utils/htmlEscape`；`description` 开头多余 `<br>` 修正。`tsc --noEmit` 全仓 0 报错。
    - [x] lu_bs（本轮提交）：修复 mtcute 迁移后的两处真实功能缺陷并补全 reload 生命周期：(1) 原实现读取 raw TL `documents` 后仍按 teleproto 的 snake_case 字段 `access_hash` / `file_reference` 构造 `inputDocument`，实际 mtcute 字段为 camelCase，发送时会得到空的 accessHash/fileReference，且强制按普通 document 发送会丢失贴纸语义；现改用 mtcute 原生 `client.getStickerSet()` 获取强类型 `StickerSet`，并直接发送 `Sticker.inputMedia`。(2) 原权限检查无条件调用仅适用于频道/超级群的 raw `channels.getParticipant`，普通群订阅会因输入类型不匹配失败；现改用同时支持普通群、超级群和频道的 `client.getChatMember()`，按 `ChatMember.status` 判断 admin/creator。(3) `cleanup()` 同步释放 DB 引用，所有 DB 入口通过带 null 守卫的 `getDB()` 重建，保证 reload 后无旧实例残留。插件仓库版本与 `.gitignore` 下本地运行副本已同步；`tsc --noEmit` 全仓及 `src/plugin/agent.ts` 均 0 报错。
    - [x] aban（本轮提交）：修复 safeGetEntity 返回信息不完整 + clearCache 竞态。safeGetEntity 原用 resolvePeer 仅返回 InputPeer 不含 firstName/username/title，导致封禁消息中目标只显示数字 ID。改为先 resolvePeer 再通过 users.getUsers/messages.getChats 拉取完整实体信息用于展示。refresh 命令中 GroupManager.clearCache() 未 await 现修复。`tsc --noEmit` 对 aban 无报错。插件仓库 f119066。
- [ ] 13. 插件架构改进同步 — setup() 初始化、cleanup() 生命周期、定时器追踪、generation-safe 模式、空 catch 清理
- [ ] 14. 全局 axios 代理支持 — teleproto 版新增的配置全局代理支持

## 🟢 低优先级
- [ ] 15. 配置文件同步 — package.json、tsconfig.json、ecosystem.config.cjs 等
