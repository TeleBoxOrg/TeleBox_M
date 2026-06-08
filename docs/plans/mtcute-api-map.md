# gramjs (teleproto) → mtcute 0.29 API 映射表

> 本表是原生重写所有任务的权威参考。基于实际安装的 @mtcute/node 0.29.7 + @mtcute/dispatcher 0.29.7 的 .d.ts 提取。

## ⚠️ 模块系统技术债(已知,已接受)

mtcute 0.29 运行时打印警告:**CommonJS bundles are deprecated**,后续版本将完全移除,不提供 CJS 支持。

- **当前决策:** 0.29.7 的 CJS require 入口仍可用(已验证 `TelegramClient`/`SqliteStorage`/`Message`/`Dispatcher` 全部正常导出),先用 CJS 路线跑通迁移,保持原版 tsx + CJS 结构,避免 123 插件全量 ESM 化的巨量摩擦。
- **后续技术债:** 全项目 ESM 化 + 锁定 mtcute 版本上限,列为独立后续工作,不阻塞本次迁移。

## 核心类型映射

| gramjs (teleproto) | mtcute 0.29 | 来源 |
|---|---|---|
| `Api.Message` | `Message` (from `@mtcute/node`) | 命令 handler 参数 |
| handler 收到的消息 | `MessageContext`(继承 Message,带回复便捷方法) | dispatcher context |
| `TelegramClient` (gramjs) | `TelegramClient` (from `@mtcute/node`) | client |
| `StringSession` | `SqliteStorage('session.db')` | session 持久化 |
| `Api.User` / `Api.Chat` / `Api.Channel` | `User` / `Chat`(mtcute 统一 Chat 抽象) | 实体 |

## 客户端方法签名(实测)

```
sendText(chatId: InputPeerLike, text: InputText, params?): Promise<Message>
sendMedia(chatId: InputPeerLike, media: InputMediaLike|string, params?): Promise<Message>
editMessage(params: InputMessageId & {...}): Promise<Message>
getMessages(chatId: InputPeerLike, messageIds: MaybeArray<number>, fromReply?): Promise<(Message|null)[]>
deleteMessages(messages: Message[], params?): Promise<void>
deleteMessagesById(chatId: InputPeerLike, ids: number[], params?): Promise<void>
```

便捷方法(send-reply / send-answer 存在):`msg.replyText(...)` / `msg.answerText(...)`。

## 方法映射(高频)

| gramjs 用法 | mtcute 等价 |
|---|---|
| `client.sendMessage(peer, {message: text})` | `client.sendText(peer, text)` |
| `client.sendMessage(peer, {message, replyTo})` | `client.sendText(peer, text, {replyTo})` |
| `msg.reply({message})` | `msg.replyText(text)` |
| `client.editMessage(peer, {message: id, text})` | `client.editMessage({chatId, message: id, text})` |
| `client.deleteMessages(peer, [ids], {})` | `client.deleteMessagesById(peer, ids)` 或 `client.deleteMessages([msgObjs])` |
| `client.getMessages(peer, {ids})` | `client.getMessages(peer, ids)` |
| `client.invoke(new Api.messages.X)` | 优先 high-level 方法;无对应用 `client.call({_:'...'})` |
| `client.invoke(new Api.channels.GetParticipants)` | `client.getChatMembers(peer, params)` |
| `client.getEntity(x)` | `client.resolvePeer(x)` / `client.getChat(x)` / `client.getUser(x)` |

## Message 属性映射(实测 getters)

| gramjs | mtcute Message |
|---|---|
| `msg.id` | `msg.id` |
| `msg.message` (文本) | `msg.text` |
| `msg.peerId` / `msg.chatId` | `msg.chat`(Chat 对象) |
| `msg.senderId` / `msg.fromId` | `msg.sender`(User/Chat) |
| `msg.media` | `msg.media` |
| `msg.replyTo` + getReplyMessage | `msg.replyToMessage` |

## 事件 / 命令分发映射

| gramjs | mtcute @mtcute/dispatcher |
|---|---|
| `client.addEventHandler(cb, new NewMessage({}))` | `dp.onNewMessage(filter, handler)` |
| `new EditedMessage({})` | `dp.onEditMessage(handler)` |
| 原始 update | `dp.onRawUpdate(filter, handler)` |
| 构造 dispatcher | `const dp = Dispatcher.for(client)` |
| 过滤器 | `filters.*`(@mtcute/dispatcher 导出 `filters` 命名空间) |

dispatcher handler 签名:
```
dp.onNewMessage(handler: (ctx: MessageContext) => Promise<void>, group?: number)
dp.onNewMessage(filter: UpdateFilter, handler, group?)
```

## raw TL 构造映射(复杂插件)

| gramjs | mtcute |
|---|---|
| `new Api.DocumentAttributeSticker({...})` | mtcute tl 对象字面量 `{_: 'documentAttributeSticker', ...}` |
| `new Api.InputStickerSetShortName({...})` | `{_: 'inputStickerSetShortName', ...}` |
| `client.invoke(new Api.X({...}))` | `client.call({_: 'x', ...})` |

> 复杂 raw 构造(sticker/document attribute)在 Phase 4 批 C 逐个核对 mtcute tl schema。

## session 迁移路径

- mtcute 无 StringSession 概念,用 `SqliteStorage` 持久化到 `session.db`。
- 旧 gramjs StringSession 无法直接转 mtcute storage → 走交互式重新登录(2FA 密码在 memory)。
- meId:`await client.getMe()` 替代旧的 session 解析。
