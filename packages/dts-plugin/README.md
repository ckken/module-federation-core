# @module-federation/dts-plugin

## 开发态类型同步（Broker / DevServer）

这套机制解决两个开发体验问题：

- **类型热同步（Hot Types Reload）**：当 provider（remote）侧类型变化时，consumer（host）侧自动拉取并更新本地 `@mf-types`。
- **页面联动刷新（Live Reload）**：当类型更新完成后，可通知浏览器侧进行 reload（可按 updateMode 控制）。

在实现上，它用一个“中心 Broker + 多端 WebSocket”的方式，把**类型更新事件**从“产出方”广播到“消费方”，并为“浏览器 reload”提供独立的 WebClient 通道。

### 角色与职责

- **Broker**：中心路由与状态存储（publishers/subscribers/web clients），负责把 Action 转换为 API 并广播。
  - 入口：[Broker.ts](./src/server/broker/Broker.ts)
- **Publisher**：每个模块（host/remote）都会作为一个 publisher 注册到 Broker；当它发生更新时向 Broker 发 UPDATE_PUBLISHER。
  - 状态模型：[Publisher.ts](./src/server/Publisher.ts)
- **Subscriber**：consumer 对其依赖的 remotes 建立订阅关系；由 Broker 将更新事件（UPDATE_SUBSCRIBER API）推送给 subscriber。
  - 订阅关系由 [DevServer.ts](./src/server/DevServer.ts) 侧发起（AddSubscriberAction）。
- **WebClient**：浏览器侧 websocket 客户端，用于接收 reload 指令。
  - 入口：[WebClient.ts](./src/server/WebClient.ts)

### UpdateMode / UpdateKind

- `UpdateKind`：更新类型
  - `UPDATE_TYPE`：类型更新链路
  - `RELOAD_PAGE`：页面刷新链路
  - 定义：[Update.ts](./src/server/message/Action/Update.ts)
- `UpdateMode`：更新传播模式
  - `POSITIVE`：主动更新（通常由变更的源头发起）
  - `PASSIVE`：被动更新（通常由接收方转发，以避免环路）
  - 定义：[constant.ts](./src/server/constant.ts)

`UpdateMode` 在类型侧的核心语义体现在 `DTSManager.updateTypes`：

- `POSITIVE` 且 `remoteName === hostName` 时，走 **generateTypes（自生成）**
- 否则走 **consumeTypes（下载并消费远端类型包）**

参考：[DTSManager.ts](./src/core/lib/DTSManager.ts)

### 端到端流程

#### 1）启动与注册

每个模块在启动 dev worker 时会创建 `ModuleFederationDevServer`：

1. 作为 **publisher** 连接到“本机 Broker”（`ws://<local-ip>:16322`）并发送 `ADD_PUBLISHER`。
2. 对配置的 `remotes`，分别作为 **subscriber** 连接到“remote 侧的 Broker”（`ws://<remote-ip>:16322`）并发送 `ADD_SUBSCRIBER`。

关键实现：[DevServer.ts](./src/server/DevServer.ts)

#### 2）订阅建立后的首次类型同步

当 broker 收到 `ADD_SUBSCRIBER`：

- 如果对应 publisher 已在线：
  - 建立 subscriber -> publisher 关系
  - 立即向 subscriber 推送一次 `UPDATE_SUBSCRIBER`（`UPDATE_TYPE`），触发首次拉取类型包
- 如果 publisher 未在线：
  - 将 subscriber 暂存到 `_tmpSubscriberShelter`
  - 等 publisher 后续上线时再补建关系并推送首次 `UPDATE_SUBSCRIBER`

关键实现：[Broker.ts](./src/server/broker/Broker.ts)

#### 3）类型更新的传播（环路抑制）

当某个模块完成类型更新后，会向 Broker 发送 `UPDATE_PUBLISHER`：

1. **发起方**：`ModuleFederationDevServer.update({ updateKind: UPDATE_TYPE })`
2. **Broker**：找到 publisher，向其所有 subscribers 广播 `UPDATE_SUBSCRIBER` API
3. **接收方**：subscriber 侧的 `DevServer` 收到 `UPDATE_SUBSCRIBER` 后执行 `_updateSubscriber`
   - 先做两层环路抑制：
     - `PASSIVE` 且 `updateSourcePaths` 已包含当前模块名：忽略
     - `updateSourcePaths` 最后一个为当前模块名：忽略
   - 调用 `updateCallback` 执行真正的类型更新（通常是 `typesManager.updateTypes`）
   - 将当前模块名 append 到 `updateSourcePaths`，并向自己的 Broker 再发送一次 `UPDATE_PUBLISHER`（强制 `PASSIVE`）

这使得“更新事件”可以沿依赖图向外扩散，但不会在环上无限回传。

关键实现：[DevServer.ts](./src/server/DevServer.ts)

#### 4）页面刷新链路

当需要刷新页面时，dev server 不走订阅更新链路，而是：

1. publisher 发送 `NOTIFY_WEB_CLIENT` action 给 broker
2. broker 找到对应 webClient，推送 `RELOAD_WEB_CLIENT` API
3. webClient 执行 `location.reload()`

关键实现：[WebClient.ts](./src/server/WebClient.ts)、[Broker.ts](./src/server/broker/Broker.ts)

#### 5）动态 remote 类型拉取（FETCH_TYPES）

对于“运行时动态远端”（`RemoteInfo`）场景，broker 会向指定 publisher 发起 `FETCH_TYPES`：

1. broker 收到 `FETCH_TYPES` action
2. broker 调用 `publisher.fetchRemoteTypes()`，向 publisher 自己的 websocket 发送 `FETCH_TYPES` API
3. publisher 侧 `DevServer` 收到 `FETCH_TYPES` 后调用 `fetchDynamicRemoteTypes({ remoteInfo })`
   - 先走一次 `updateCallback` 拉取/更新动态远端类型
   - 再向 broker 发送 `UPDATE_PUBLISHER`（以 `UPDATE_TYPE` 形式传播给 subscribers）

关键实现：[DevServer.ts](./src/server/DevServer.ts)、[Broker.ts](./src/server/broker/Broker.ts)

### Broker 自启动（后台进程）

当 dev server 连接本机 broker 失败（`ECONNREFUSED/ETIMEDOUT` 且端口为 16322）时，会 fork 一个后台 broker：

- 创建逻辑：[createBroker.ts](./src/server/broker/createBroker.ts)
- broker 子进程入口：[startBroker.ts](./src/server/broker/startBroker.ts)

注意：`createBroker` fork 的是编译后的 `start-broker.js`（位于构建产物目录）。

### 消息协议（概要）

- Action（客户端 -> Broker）：
  - `ADD_PUBLISHER` / `UPDATE_PUBLISHER` / `EXIT_PUBLISHER`
  - `ADD_SUBSCRIBER` / `EXIT_SUBSCRIBER`
  - `ADD_WEB_CLIENT` / `NOTIFY_WEB_CLIENT`
  - `FETCH_TYPES` / `ADD_DYNAMIC_REMOTE`
  - 定义入口：[Action.ts](./src/server/message/Action/Action.ts)
- API（Broker -> 客户端）：
  - `UPDATE_SUBSCRIBER`
  - `RELOAD_WEB_CLIENT`
  - `FETCH_TYPES`
  - 定义入口：[API.ts](./src/server/message/API/API.ts)
