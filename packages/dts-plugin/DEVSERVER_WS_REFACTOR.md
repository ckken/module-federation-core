# DevServer 多 WebSocket 连接“无返回内容”分析与重构步骤

本文聚焦 `ModuleFederationDevServer` 在同一项目/同一机器上存在多条 WebSocket 连接时，出现“连接已建立但长期收不到预期消息（例如 UPDATE_SUBSCRIBER/FETCH_TYPES）”的典型根因，并罗列一套不改业务语义的重构步骤。

相关源码入口：

- Publisher 连接本机 Broker：`ws://${this._ip}:16322?...`：[DevServer.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/DevServer.ts#L86-L114)
- Subscriber 连接 remote 侧 Broker：[DevServer.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/DevServer.ts#L209-L334)
- Broker 的 publisher/subscriber 匹配逻辑：[Broker.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/broker/Broker.ts#L191-L429)
- 标识符构造（name/ip 绑定）：[utils/index.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/utils/index.ts#L8-L11)
- 本机 IPv4 选择策略（“取第一个非 127 IPv4”）：[getIPV4.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/utils/getIPV4.ts#L26-L30)
- `localhost/127.0.0.1` entry 被替换为本机 IPv4：[dev-worker/utils.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/dev-worker/utils.ts#L1-L12)

## 现象定义

这里的“无返回内容”通常包含两类：

1. **Subscriber 链路无回包**：`AddSubscriberAction` 已发送，但长期收不到 `UPDATE_SUBSCRIBER`（首次同步和后续更新都没有）。
2. **Publisher 链路无回包**：publisher 侧与 broker 已建立连接，但收不到 broker 发来的 `FETCH_TYPES`，或 broker 发了但 publisher 侧逻辑未触发。

注意：DevServer 侧并没有“握手 ACK”机制；除了日志，你很难区分“已注册成功”和“仅仅 TCP 连接成功”。

## 高概率根因（按优先级）

### 根因 1：把“身份”绑定到 `getIPV4()`，在多网卡环境会失配

身份标识符由 `name + ip` 组成：`getIdentifier({ name, ip })`。[utils/index.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/utils/index.ts#L8-L11)

但 `getIPV4()` 的策略是“拿到第一张非 127 的 IPv4 网卡地址”。在 macOS/Windows/多 VPN/多网卡场景，这个“第一张网卡”并不稳定：

- remote A 进程可能拿到 `192.168.1.10`
- host B 进程可能拿到 `10.0.0.5`

此时会产生致命失配：

1. remote 的 broker 内部登记 publisher：`(remoteName, 192.168.1.10)`
2. host 通过 entry 解析远端 IP 时，如果 entry 是 `localhost`/`127.0.0.1`，会被替换成本机 IPv4（host 进程自己的 IP）：[dev-worker/utils.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/dev-worker/utils.ts#L9-L11)
3. host 向 remote broker 发 `ADD_SUBSCRIBER` 时携带 publisher 信息 `(remoteName, 10.0.0.5)`
4. remote broker 查不到 `(remoteName, 10.0.0.5)` 对应的 publisher，于是把订阅关系丢进 `_tmpSubscriberShelter`（临时庇护），等待一个永远不会出现的 publisher 上线：见 [Broker.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/broker/Broker.ts#L359-L381)

最终表现：subscriber socket “连接正常，但永远收不到 UPDATE_SUBSCRIBER”。

### 根因 2：publisher 重复注册被 Broker 忽略，导致 Broker 持有“旧 ws”

Broker 在 `ADD_PUBLISHER` 时，如果 `name+ip` 已存在会直接 ignore，不会覆盖旧连接：

- [Broker.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/broker/Broker.ts#L195-L204)

当同一台机器上同时跑多个同名模块（或热重启导致旧连接未及时清理），会出现：

- 新进程的 publisher ws 已连接，但 broker 仍引用旧进程 ws
- broker 触发 `FETCH_TYPES` 时会发给旧 ws（`Publisher._ws`），新进程自然“收不到返回内容”

相关：`Publisher.fetchRemoteTypes` 会用 publisher 创建时保存的 `_ws` 发送：[Publisher.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/Publisher.ts#L103-L118)

### 根因 3：subscriber 端没有重连机制

subscriber websocket 只在 `close/error` 时删除引用，并不会自动重连：

- [DevServer.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/DevServer.ts#L310-L333)

remote broker 重启或短暂不可达后，subscriber 侧会“永久断订阅”，后续自然无消息。

### 根因 4：缺乏心跳/超时与“注册成功”的可观测性

当前系统仅依赖 ws 层 `open/close/error` 与少量日志。缺少：

- ping/pong 心跳检测
- 连接鉴权/注册成功 ACK
- publisher/subscriber 注册状态在应用层的确认

在网络抖动或代理环境，容易出现“open 过，但应用层永远没进入预期状态”。

## 排查建议（不改代码时可做）

1. **对齐 identifier**：从日志里拿到双方的 `identifier = mf${SEPARATOR}${name}${SEPARATOR}${ip}`，确认 remote broker 看到的 publisher id 与 host 发送的 publisher id 完全一致。
2. **验证网卡选择**：在同机多网卡环境，把 VPN/虚拟网卡临时关闭后复现对比，验证是否为 `getIPV4()` 取值不一致导致。
3. **复现“重复注册”**：同时启动两个同名模块，观察 broker 是否出现 `has been added, this action will be ignored` 日志。
4. **验证 broker 重启**：重启 remote broker，看 subscriber 是否会恢复订阅（目前不会）。

## 重构步骤（按阶段）

下列步骤按“收益/风险”从低到高排序，尽量保持外部行为不变。

### 阶段 0：建立可观测性与可复现用例

1. 给 publisher/subscriber/webClient 增加统一的 connectionId（例如 pid + 启动时间戳）。
2. 在 broker 侧对每次 action 记录：action kind、sender connectionId、解析出的 identifier。
3. 补一组端到端用例（可用 node 启多个进程模拟）：
   - 同机多网卡（模拟不同 ip）导致 `ADD_SUBSCRIBER` 进入 tmp shelter
   - 同名 publisher 重启（旧 ws 未清理）导致 `FETCH_TYPES` 发到旧 ws
   - remote broker 重启后 subscriber 是否能恢复

### 阶段 1：解耦“连接地址”与“身份标识”

1. 引入显式的 `brokerHost`/`brokerIp` 配置；同机默认强制 `127.0.0.1`。
2. 将 `identifier` 从 `name+ip` 调整为更稳定的维度：
   - 逻辑标识：`moduleName`
   - 实例标识：`moduleName + instanceId`（用于多实例并存）
3. 对 `localhost/127.0.0.1` entry 不再替换为 `getIPV4()`，改为：
   - 连接地址走 127.0.0.1
   - 身份标识不依赖网卡 ip

### 阶段 2：Broker 侧支持“同名重连覆盖”

1. `ADD_PUBLISHER` 不再简单 ignore：
   - 若 identifier 已存在但 ws 已失效，允许替换
   - 或按 instanceId 同时存多个 publisher，并规定路由策略
2. `UPDATE_PUBLISHER/FETCH_TYPES` 校验 sender ws 与登记 ws 是否一致；不一致时返回错误并提示重新注册。

### 阶段 3：subscriber 重连与连接状态机

1. 将 subscriber 连接从“只连一次”改为带 backoff 的重连（可复用 publisher 的 fib/backoff 思路）。
2. 引入连接状态机：CONNECTING/REGISTERED/READY/RETRYING/CLOSED。
3. 明确“注册成功”的应用层 ACK：
   - broker 在处理 `ADD_PUBLISHER/ADD_SUBSCRIBER/ADD_WEB_CLIENT` 后返回一个 API ACK
   - DevServer 只有在收到 ACK 后才认为 `_isConnected` / “订阅建立成功”

### 阶段 4：心跳与过期清理

1. WebSocket ping/pong 心跳，检测半开连接。
2. publisher/subscriber/webClient 引入 TTL，超时自动清理。
3. 对 `_tmpSubscriberShelter` 的清理逻辑统一，避免“临时订阅永远挂着”。

## 与当前实现的关键对照点

- 当前 publisher 地址使用 `getIPV4()`：[DevServer.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/DevServer.ts#L76-L84)
- 当前 subscriber 连接远端 broker 的 ip 可能来自本机 `getIPV4()`（当 entry 为 localhost/127 时）：[forkDevWorker.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/dev-worker/forkDevWorker.ts#L36-L63) + [dev-worker/utils.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/dev-worker/utils.ts#L9-L11)
- broker 对重复 publisher 的处理是 ignore（风险点）：[Broker.ts](file:///Users/ken/Desktop/develop/empjs-workspace/module-federation-core/packages/dts-plugin/src/server/broker/Broker.ts#L195-L204)

