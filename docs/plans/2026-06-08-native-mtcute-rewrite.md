# TeleBox-Next 原生 mtcute 重写实施计划

> **For Hermes:** 用 subagent-driven-development 技能逐任务执行本计划。用户已显式授权本次迁移使用多 agent 工作流。

**Goal:** 把 TeleBox-Next 从 teleproto(gramjs 分支)完全重写为原生 @mtcute/node 0.29，零 gramjs 残留、零 adapter 兼容层。

**Architecture:** 保留与 Telegram 库无关的运行时框架(generation 代际管理 / GenerationContext 的 abort-drain-dispose 生命周期 / cronManager / logger / *DB 工具)。换血层:client 创建、session、Plugin 契约、123 个插件的命令处理器。命令签名从 `Api.Message` 改为 mtcute 原生 `Message`，命令分发改用 @mtcute/dispatcher。

**Tech Stack:** @mtcute/node 0.29.7、@mtcute/dispatcher、@mtcute/sqlite(session 存储)、TypeScript CJS + tsx(保持原版模块结构，mtcute/node 提供 .cjs require 入口，无需全量 ESM 化)。

**模块系统决策(已知技术债):** mtcute 0.29 运行时警告 CJS 入口 deprecated、将移除。但 0.29.7 的 CJS require 仍正常(已验证)。决策:先用 CJS + tsx 保持原版结构跑通迁移,避免 123 插件全量 ESM 化摩擦;全项目 ESM 化列为独立后续技术债,锁定 mtcute 版本上限不阻塞本次迁移。

**关键约束:**
- 干净基线:主仓库 HEAD `636df5f`，插件仓库 HEAD `4a4db43`。**不复用** backup 分支的 adapter 成果(用户明确要求完全重写)。
- 旧迁移 state 已归档至 `/root/.hermes/archive/`，backup 分支 `backup/pre-reset-20260608-124348` 保留作参考。
- 生产机原版 telebox 在 `/root/telebox` 持续运行，**禁止启动会抢占同账号 session 的实时客户端**——除非用户提供独立测试账号。验证以静态编译(tsc --noEmit)+ 结构审计为主。
- 提交身份必须为 `TiaraBasori <mintabyss233@gmail.com>`，修复需 push 到远程。
- 主仓库 + 插件仓库改动必须同步。

---

## Phase 0:环境准备与依赖切换

### Task 0.1:安装 mtcute 依赖、移除 teleproto

**Objective:** package.json 依赖从 teleproto 切到 mtcute 全家桶。

**Files:** Modify `/root/telebox-next/package.json`

**Step 1:** 安装原生依赖
```bash
cd /root/telebox-next
npm install @mtcute/node@0.29.7 @mtcute/dispatcher@0.29.7 @mtcute/sqlite@0.29.7
```

**Step 2:** 暂不删除 teleproto(插件类型导入仍依赖，Phase 4 末才移除)。在 package.json 标注待移除。

**Step 3:** 验证
```bash
node -e "const c=require('@mtcute/node'); console.log(Object.keys(c).filter(k=>/Client|Message|TelegramClient/.test(k)))"
```
Expected: 输出含 `TelegramClient`。

**Step 4:** 提交
```bash
git add package.json package-lock.json
git commit --author="TiaraBasori <mintabyss233@gmail.com>" -m "feat(deps): add native @mtcute/node 0.29 stack"
```

### Task 0.2:确立 API 映射参考表

**Objective:** 产出 gramjs→mtcute 方法/类型映射文档，供后续所有任务参考。

**Files:** Create `/root/telebox-next/docs/plans/mtcute-api-map.md`

映射核心(从评估数据 Api.* 频次倒排):
- `Api.Message` (897+95次) → mtcute `Message` (from `@mtcute/node`)
- `client.sendMessage(peer, {message})` → `client.sendText(peer, text)` / `client.sendMedia`
- `client.getMessages` → `client.getMessages` (签名不同，需核对)
- `client.invoke(new Api.messages.X)` → 优先用 high-level 方法，无对应再用 `client.call({_:'...'})`
- `Api.channels.*` / `Api.contacts.*` → high-level `client.getChatMembers` 等
- 事件 `NewMessage` → @mtcute/dispatcher `dp.onNewMessage`
- raw TL 构造(媒体/sticker attribute)→ mtcute tl 命名空间

**Step:** 写表并提交。

---

## Phase 1:核心 client + session 原生化

### Task 1.1:原生 client 工厂

**Objective:** 重写 `createClient`，用 mtcute TelegramClient + SqliteStorage 替换 gramjs。

**Files:** Modify `src/utils/runtimeManager.ts:109-148`(createClient/destroyClient)、新建 `src/utils/mtcuteClient.ts`

要点:
- `new TelegramClient({ apiId, apiHash, storage: new SqliteStorage('session.db'), ... })`
- 代理:mtcute 用 `transport` / `TcpTransport` + proxy 形式，核对 apiConfig.proxy 形态
- `destroyClient`: mtcute `client.close()`
- 保留 generation/context 包装不变

**验证:** `npx tsc --noEmit` 该文件无新错误。

### Task 1.2:session 迁移 / loginManager 原生化

**Objective:** loginManager 从 gramjs StringSession 改为 mtcute storage；提供从旧 StringSession 一次性导入路径。

**Files:** Modify `src/utils/loginManager.ts`(262行)

要点:
- mtcute 用 SqliteStorage 持久化，无 StringSession 概念
- 提供 `importFromGramjsStringSession`(可选迁移辅助)——若无法直接转换则走交互式重新登录(用户 2FA 密码 mintLinux 在 memory)
- `initializeClientSession` 返回 meId 改用 `client.getMe()`

**验证:** tsc + 登录流程静态走查(不实跑，避免 session 冲突)。

### Task 1.3:globalClient 类型切换

**Files:** Modify `src/utils/globalClient.ts`(9行)、`src/utils/apiConfig.ts`

把 `TelegramClient` 类型从 teleproto 改为 @mtcute/node。

---

## Phase 2:Plugin 契约 + 命令分发原生化

### Task 2.1:重定义 Plugin 基类

**Objective:** `pluginBase.ts` 的 `cmdHandlers` 签名从 `Api.Message` 改为 mtcute `Message`。

**Files:** Modify `src/utils/pluginBase.ts`(99行)

```typescript
import { TelegramClient, Message } from "@mtcute/node";

abstract class Plugin {
  abstract cmdHandlers: Record<
    string,
    (msg: Message, trigger?: Message) => Promise<void>
  >;
  listenMessageHandler?: (msg: Message, options?: { isEdited?: boolean }) => Promise<void>;
  // eventHandlers 改用 dispatcher 形态
  // cronTasks handler(client: TelegramClient)
}
```

**注意:** 这是**破坏性契约变更**——123 个插件全部依赖此签名。先改契约让基类编译通过，插件在 Phase 4 批量迁移。

### Task 2.2:命令分发器原生化

**Objective:** `pluginManager.ts` 的消息监听/命令路由改用 @mtcute/dispatcher。

**Files:** Modify `src/utils/pluginManager.ts`(596行)、`src/hook/listen.ts`、`src/hook/patches/telegram.patch.ts`

要点:
- 用 `Dispatcher.for(client)` + `dp.onNewMessage` / `dp.onEditMessage`
- 前缀解析 `getPrefixes` 保留(纯字符串逻辑)
- 把 gramjs 的 `client.addEventHandler(new NewMessage())` 全部替换
- `safeGetMessages` / `safeGetReplyMessage` / `conversation.ts` / `entityHelpers.ts` 原生化

### Task 2.3:核心内置插件迁移(19个 src/plugin/*.ts)

按依赖顺序逐个迁移 src/plugin 下 19 个内置插件(ping/status/reload/tpm/help/sudo/sure/bf/debug/exec/...)。每个一任务,TDD 走查 + tsc 验证。tpm.ts(1439行)单独成任务。

---

## Phase 3:工具层原生化

把 `banUtils.ts`/`channelGapBreaker.ts`/`telegramFormatter.ts`/`telegraphFormatter.ts`/`tlRevive.ts`/`safeGetMessages.ts` 等剩余 teleproto 引用工具逐个原生化。每个一任务。

---

## Phase 4:123 插件批量迁移(TeleBox-Next_Plugins)

**策略:** 按 Api.* 复杂度分三批。每批用 subagent 并行(用户已授权多 agent，最多 3 并发)。

- **批 A — 简单插件**(仅 Api.Message + sendText/edit/delete):约占多数，机械替换
- **批 B — 中等**(getMessages/channels/contacts/媒体下载)
- **批 C — 复杂**(sticker/document attribute 构造、raw TL invoke、自定义事件)

每个插件迁移后:tsc --noEmit 该插件 0 错误 + 命令注册静态校验。
单 tsconfig 批量编译全部插件,以 0 error 为批次完成门槛。

---

## Phase 5:整体验证与收口

- Task 5.1:两仓库 `tsc --noEmit` 全绿,grep 确认 0 个 `from "teleproto"` 残留
- Task 5.2:移除 package.json 的 teleproto 依赖 + `npm prune`,删除 `src/hook/types/telegram.d.ts` 的 teleproto module augmentation
- Task 5.3:run-tsx.cjs 入口加载冒烟(不连真实账号)
- Task 5.4:文档更新 + 两仓库提交 push(身份 TiaraBasori)
- Task 5.5:(需用户提供测试账号或授权窗口)实时登录冒烟——发一条命令验证端到端

---

## 执行顺序总览

```
Phase 0 (依赖+映射表) → Phase 1 (client/session) → Phase 2 (Plugin契约+分发+内置插件)
→ Phase 3 (工具层) → Phase 4 (123插件,3并发subagent) → Phase 5 (验证收口)
```

Phase 0-3 是关键路径,必须串行(契约先行)。Phase 4 可并行扇出。Phase 5 收口。
