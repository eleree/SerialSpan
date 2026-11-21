# ShareSerial 协议 v3

Local 连接 `/ws/local`，Remote 连接 `/ws/remote`。WebSocket 消息为 JSON 文本帧，中转串口数据使用规范 Base64。发送方身份始终来自连接；消息中的 localId/remoteId 不证明身份。v3 支持多个可发送 Remote 与 Local 统一排队，不再授予独占写入权。

## 串口 P2P 扩展

### TX 队列触顶后的拆分路由

双方可在 `register`/`connect` 声明可选 `serialP2PTXRelayProtocol:1`，且必须同时声明 `serialP2PProtocol:1`。服务器只在当前 Local 与该 Remote 均支持时回传协商结果；不支持的旧端继续使用现有整条连接回退。

当 Local 等待配对的直连 TX 项达到 16 项时，支持该扩展的 Local 可发送 `p2p_serial_signal`，`probeKind:tx_relay`、`p2pReason:tx_queue`、当前端口/授权/轮次及实际 Local 身份必须匹配。服务器只对该 Remote 置 `serialTXRelay:true`，并拒绝其后续 `p2p_serial_tx` 许可（`p2p_tx_relay`）；该 Remote 之后的普通 `send` 仍通过服务器授权并进入原有 Local FIFO。当前串口 DataChannel 保持开启，Local RX 仍走直连；其他 Remote 的状态不变。

切换时两端清除未完成的直连 TX 项，结果视为未知且不自动重放。用户应先检查设备状态，再决定是否重新发送。暂停、撤销、参数变更、烧录独占、写入代次、逐条授权和统一 FIFO 规则不变。该模式只针对新旧端均协商支持的会话。

TX 中转且 RX 直连时，页面的“评估网络”按服务器中转路径采样，不把双向 P2P 探测结果误作实际 TX 路径性能。

部署端可用 `-stun-urls` 指定最多四个 `stun:host[:port]` 地址（IPv6 使用方括号），默认不配置外部服务；拒绝 TURN、凭证、路径、查询参数及非法端口。`GET /api/serial-p2p-config.js` 返回有界、禁止缓存的同源 JavaScript 配置，`ShareSerialICE` 包含 `schemaVersion:1` 与 `iceServers`，受现有 HTTP 资源预算约束；请求参数不能覆盖部署配置。页面加载该配置后自动协商，配置不可用时保留本地候选与 WSS 回退。STUN 只发现地址，不承载串口字节，不能保证所有 NAT 环境直连；没有启用 TURN。

`p2p_serial_signal` 的空载荷 `fallback` 可另带可选 `p2pReason`。只接受固定代码：`webrtc_unavailable`、`webrtc_disabled`、`negotiation_timeout`、`connection_failed`、`connection_disconnected`、`connection_closed`、`channel_closed`、`channel_error`、`sdp_error`、`candidate_error`、`signal_limit`、`invalid_frame`、`application`、`backpressure`、`peer_fallback`；省略时按对端回退处理。`ready` 不允许携带原因。`p2p_serial_state` 回传本授权内首次回退原因，迟到的第二次回退不能覆盖它。原因是浏览器报告的诊断分类，不是服务器确认的 NAT 类型；身份、端口、授权、写入校验规则不变。

Local/Remote 的串口终端只显示 RX/TX；连接状态悬停提示保留简要状态，详细事件可按需导出系统日志。`getConnectionDiagnostics()` 返回当前连接的阶段、ICE 状态、收发提议/应答标志、候选类型计数、耗时及既有字节计数。诊断不包含 SDP、候选 IP、授权令牌、STUN URL 或原始浏览器错误文本，失败后保留关闭 PeerConnection 前的快照。服务器记录 `serial_p2p_capability` 与状态发生变化时的 `serial_p2p_state`，重复状态不重复写日志。

普通串口回退时先立即禁用本端直连收发、取消旧直连发送并切换中转，再用最多 200 ms 的一次 `getStats()` 尝试保留统计，随后关闭 Native PeerConnection。采集不阻塞 WSS，不延迟撤销/断线清理；授权失效后不得上报或显示迟到结果。`fallback` 可携带 `p2pDetails`：`ice`（unavailable/new/checking/connected/completed/failed/disconnected/closed）、`dtls`（unavailable/new/connecting/connected/failed/closed）、`sctp`（unavailable/connecting/connected/closed）、`checksSent`、`responsesReceived`、`requestsReceived`（整数 0..1000000）、`validPairs`（0..64）、`statsAvailable`。后者仅表示取得候选对统计；未取得时计数必须为 0，不能当作测得零回包。最多汇总 64 个候选对，不包含地址、原始统计 ID 或证书。

`p2pDetails` 另可带诊断上下文：`applicationCause`（空或 rx_send/rx_queue/tx_send/tx_queue/tx_wait/serial_frame/tx_integrity/tx_dispatch）、`channelError`（空或 unavailable/sctp-failure/data-channel-failure/dtls-failure）、`sctpCauseCode`（仅 sctp-failure 可带，整数 0..65535）、`channelState`（空或 unavailable/connecting/open/closing/closed）、`serialBufferedAmount`、`assessmentBufferedAmount`（整数 0..1048576）及 `assessmentActive`（布尔）。应用回退在关闭评估通道前冻结上下文；原生通道错误只取类型和 SCTP 数字码，不上报原始错误文本。旧端可省略扩展字段。

`ready` 不得携带详情。服务端按真实连接校验详情，`p2p_serial_state` 仍保留首次回退的副本及由实际 Socket 决定的 `p2pReporter`（local/remote）；消息内伪造的报告者不生效。另一端收到回退通知后，在同一授权和协商轮次内补报自己的快照；已自行报告的端不重复发送，迟到到新轮次或授权失效后的采集结果丢弃。补报不改最初回退原因、重试时间、串口授权或 TX 执行。

服务器以 `serial_p2p_failure_details` 记录两端快照，每个实际报告者每个 grant/协商轮次最多一条。`primary` 区分是否为首次报告者，另记录该端 `reported_reason`、ICE/DTLS/SCTP、统计与上述脱敏上下文；`sctp_cause=-1` 表示未提供数字码。撤销/断开和新轮次重置日志去重状态。均为浏览器报告的诊断证据，不参与串口授权，也不记录串口内容、地址、SDP 或原始错误。页面日志清空不会删除服务器已有快照；服务端日志保留时间由部署配置决定。

普通 Local/Remote 可在 `register`/`connect` 声明 `serialP2PProtocol:1`，须同时支持 `rxReplayProtocol:1`，不得与合成 `p2pProbeProtocol` 混用。`register` 返回 Local 能力；批准后的 `remote_connected`、`connect` 返回双方协商的能力。已有授权内不能通过再次 connect 修改传输能力。旧端不声明时继续中转。

`p2p_serial_signal` 使用 `portId`、当前 `grantId`、`probeKind`、`probePayload`；Local 还指定目标 `remoteId`。服务器从实际 Socket/订阅重构身份，拒绝待批准、其他 Local、旧 grant、错误端口和未协商能力。种类为 Remote `offer` / Local `answer`（非空 SDP，最多 16 KiB）、双方 `candidate`（JSON 最多 2048 B，candidate 字符串 1..1024 B）、空载荷 `ready` / `fallback`。双方 ready 后返回的 `p2p_serial_state` 中，`direct:true` 表示可直连，省略/false 表示尚未就绪或中转；`probeKind:fallback` 表示当前轮次已回退，迟到 ready 不可恢复直连。WebRTC 使用可靠、有序 DataChannel，可使用部署端的可选 STUN 配置；普通串口每轮最多尝试 45 秒，浏览器先报告连接失败则立即回退。协商期间 WSS 已可正常收发，不等待直连完成。

两端可另外声明 `serialP2PRetryProtocol:1`（必须同时声明 `serialP2PProtocol:1`）；服务器在注册确认及批准消息中返回能力，只有双方均支持才协商为 1。已有授权内不得变更能力。初始 `p2pAttempt` 为 0（可省略）；`p2p_serial_signal`、`p2p_serial_tx`、`p2p_serial_permit` 和 `p2p_serial_state` 均携带当前轮次。旧轮次信令和 TX 被忽略，未来或负轮次被拒绝；补传仍按 grant 和 RX 流校验，不随直连轮次重置。

仅实际 Remote 可发送空载荷 `probeKind:retry`，携带上一轮 `p2pAttempt`。服务器要求该轮已回退、双方支持重试、未满 4 轮且批准后的 180 秒窗口尚未结束，并执行 5/10/20 秒退避。仅 `negotiation_timeout`、`connection_failed`、`connection_disconnected`、`channel_closed`、`channel_error` 可重试，已报告 `dtls:failed` 的失败不重试。服务器递增轮次、清除双方 ready 和本轮失败快照，向双方发送 `probeKind:retry` 的状态；双方收到后关闭旧通道并新建 PeerConnection，由 Remote 发起新 offer。浏览器最后一轮期限缩短到总窗口剩余时间；已健康直连不会因窗口结束而关闭。Remote 只安排一个重试计时器，撤销、断线或停止共享后取消；旧端保持单轮回退，不自动重试。

重试不改变 grant、写入代次或 RX 游标，不重置 TX 单调序号，不重放任何串口命令。过期通道、旧许可及迟到摘要/发送失败不得执行字节或结束新一轮。现有日志显示尝试轮数和重试等待，服务器记录 `serial_p2p_retry`，不记录候选地址。

远端 TX 字节走直连前必须逐条发送 `p2p_serial_tx`：`portId`、`grantId`、`writeEpoch`、安全整数 `txSeq`（1..2^53-1，授权内严格递增）、`byteLength`（1..16384）、`sha256`（64 位小写 hex）。服务器校验实际完全控制 Remote、当前 Local/端口/授权/写入代次、未暂停、参数已确定、无烧录独占及双方直连就绪，再给双方发送 `p2p_serial_permit`，绑定同一序号、长度、摘要与授权状态。Remote 收到匹配许可才发送字节；Local 按许可顺序配对数据，复核长度和 SHA-256，异步摘要完成后再校验权限，最后进入原有有界写队列并在实际写入前复核。重复许可/序号不执行；待配对 TX 最多 16 项，10 秒未配齐中止并回退，发送端待处理数据另限 192 KiB。不提供物理执行 ACK，不自动重发失败 TX。

直连二进制帧为 16 字节头和 1..16384 B 原始字节：前五字节 `[83,83,80,1,kind]`，kind=1 为 Remote TX、2 为 Local RX，字节 5..7 为零，字节 8..15 为小端 uint64 序号（必须可安全表示为 JS 整数）。RX 序号与当前 RX 缓存流一致；通道绑定一次 grant 与串口会话，不接收其他方向或过期通道的帧。DataChannel 积压上限 64 KiB，Local 等待直连发送的 RX 最多 16 项且不超过 192 KiB；背压超限回退。

Local RX 仍发送 `type:data`，增加 `serialP2PProtocol:1` 和最多 16 个 `directRemotes`，保留原 `rxStreamId/rxSeq`。已交给直连发送队列且服务器确认直连的目标不再收到 WSS 数据副本；有中转端、补传端或未决申请时仍上传 Base64 数据，全部已知端都走直连时可省略 data。服务器校验当前 Local/端口、全局连续 RX 序号与 Base64；有旧端时不允许省略载荷。每个支持 P2P 的 Remote 都收到不含载荷的 `p2p_serial_head`（当前 grant/流/序号），因此尾部直接帧丢失也能发现。

Remote 使用同一 RX 游标对两条路径排序、去重；暂存最多 256 帧/192 KiB。检测到头部领先 150 ms 仍未收到数据时发送 `p2p_serial_resume`，携带当前 port/grant、`rxStreamId`、`resumeSeq`。服务器校验授权和流，将 `p2p_serial_replay` 通知 Remote，并复用既有 Local `resume_rx`、WSS 补传/ACK/缺口/完成流程。请求发出后冻结游标，等待服务端补传通知前不交付迟到的 WSS 实时帧；修复期间不交付直连实时帧，完成后按最新 head 再检查，无需重新审批。过期/溢出显示缺口，连续 30 秒接收游标无有效进展时提示等待网络，已授权补传仍可继续；持续进展时续期该提示计时，完成后清除同类停滞提示。此恢复仅补收 RX，不重放 TX。

暂停/撤销/停止共享/控制 WSS 断开仍按原规则立即作废旧操作；直连不能脱离控制 WSS 继续运行。参数修改、串口控制信号和 ESP32 烧录仍经原 WSS 事务/独占会话。本扩展新增错误包括 `p2p_not_authorized`、`invalid_p2p_signal`、`p2p_not_ready`、`invalid_p2p_tx`、`p2p_tx_relay`、`p2p_attempt_expired`、`p2p_retry_unavailable`，以及既有只读、暂停、代次、参数和烧录错误。网络参考按当前路径选择 HTTP 采样或下述独立 P2P 探测。

### P2P 网络参考通道

点击评估时，发起页须已收到服务器的直连确认，在当前已授权的 PeerConnection 上按需创建可靠、有序的 `shareserial-network-v1` DataChannel。接收端校验当前授权、PeerConnection 和已打开的主数据通道，允许自己的服务器直连通知稍后到达；网络探测不能借此调用串口处理。该通道与 `shareserial-serial-v1` 分离，不计入 RX/TX。只读授权也允许网络探测；不新增服务器信令、WebSocket 写入者或串口写权限。当前 grant、PeerConnection/协商轮次、直连状态失效或取消时关闭探测；旧版对端关闭未知通道时仅评估失败，不中断串口通道或悄悄改测服务器。

控制帧为最多 256 UTF-8 字节 JSON：`hello(v=1)` / `hello_ready(v=1)`，随后按 id=0..5 顺序 `ping` / `pong`。四个固定样本 id=0..3，方向依次为 up、up、down、down，每个 32768 B。发送样本使用 `sample(id,dir)` → `up_ready(id)` → 二进制 → `up_done(id)`；接收样本使用 `sample(id,dir)` → 二进制 → `down_ack(id)` → `next(id)`。方向以发起页为准，状态和序号不匹配拒绝。

二进制帧头 12 B：魔数 `53 53 4E 01`、大端 uint32 样本 id、大端 uint32 样本内偏移；载荷最多 4096 B，按 `(样本内偏移+i)%251` 校验，偏移必须连续。每轮有效样本共 128 KiB，含帧头和控制的双向总预算 144 KiB；每端最多接收 96 条消息，发送缓冲上限 8 KiB。每页同时一个探测，启动间隔至少 30 秒，整轮最多 20 秒；ping 等待 1.5 秒，其他待应答操作最多 5 秒。配置、烧录、定时发送或 RX 补传等事务期间拒绝 P2P 评估，进行中再次遇到忙状态停止探测。路径或授权改变也使页面旧参考结果失效。探测超时率不是 IP 丢包率。

普通串口 P2P 接收端在补传期间不使用服务器的第二份实时 RX 队列。服务器仅发送当前 head，实际字节仍保留于 Local 有界缓存；补传完成后再次发送最新 head，接收端按当前游标请求下一段。Local 可同时通过 P2P 发送实时尾部，Remote 将超出本轮 `throughSeq` 的直连帧按原 256 帧/192 KiB 上限暂存，历史 WSS 字节确认完成后再合并交付；直连帧不能确认服务器尚未发送的历史序号。尾部暂存溢出时清空暂存并通过 head 发现后续缺口，继续请求缓存，不因此撤销连接；缓存无法覆盖时明确提示缺口。旧端继续使用原有有界补传队列和慢端保护。此协同只补收 RX，不重复提交 TX，也不改变暂停、撤销和断线规则。

`p2p_not_authorized` 可携带被拒绝消息的 `grantId`、`portId` 和对应 `remoteId`，仅向原发送方关联已结束的协商。客户端忽略与当前授权不匹配的旧 P2P 错误，当前授权的错误仍显示；服务器仍拒绝旧授权，不能据此恢复连接或发送字节。定时发送复用既有逐条授权路径，不增加周期授权或设备执行 ACK；每次都重新校验发送条件，停止后不补发错过或失败的周期。

定时发送在 TX 意图尚未提交前可取消；意图已提交后，停止定时仅阻止新周期，授权仍有效的这一条完成一次，避免 Local 留下许可却收不到对应字节的阻塞项。暂停、撤销、参数变更或断线仍可作废它；两端清理旧 TX 状态并保留 RX 直连，Local 对过期写入代次的许可推进拒收序号并清理暂存，迟到帧不得阻塞新写入。停止时仍成功提交的在途字节计入 TX，不代表设备执行 ACK。

## 实验性合成 P2P 扩展



仅 `/experimental/p2p` 使用，不操作物理串口。Local 在 `register` 声明 `p2pProbeProtocol:1`，且唯一端口为 `p2p-probe`，不得同时声明串口配置、控制信号、烧录或 RX 补传能力；Remote 在 `connect` 声明同一扩展，默认仍申请只读。双方具备能力并经 Local 批准后，`connect` 与 `remote_connected` 返回 `p2pProbeProtocol:1`。

`p2p_probe_signal` 包含 `portId`、当前 `grantId`、`probeKind`、`probePayload`；Local 还需指定目标 `remoteId`。Hub 按实际连接和订阅重新构造身份，拒绝未获批、旧授权、其他 Local、错误端口和不支持能力的端。允许种类：Remote 发 `offer`、Local 发 `answer`（SDP 最多 16 KiB）；双方可发 `candidate`（JSON 最多 2048 B，candidate 字符串最多 1024 B）、空载荷 `fallback`、以及最多 512 B 的类型化 `receipt`。回执为 `{"op":"complete","id":N,"bytes":N,"sha":"64 位 hex"}` 或 `{"op":"rejected","id":N,"code":"原因"}`，只读端可回复。

`p2p_probe_frame` 是合成中继兜底，`data` 为 1..16384 B 的 Base64，身份/端口/grant 必须匹配。Remote 发送还需完全控制、未暂停及当前 `writeEpoch`；Local 可向单个获批 Remote 转发合成数据。它不进入物理串口写入路径。直连二进制格式、缓冲和验证边界见 [P2P 本机实验](docs/P2P_PROBE.md)。错误码包括 `probe_unsupported`、`invalid_probe_signal`、`probe_write_denied`，以及既有的授权/端口/数据错误。

WebRTC 仅在批准后协商；没有外部 ICE 服务器。直连失败或关闭后中止当前合成测试，新测试可经 WSS 执行，不自动重放旧数据；控制 WSS 断开即清理直连。此扩展不代表正常串口或 ESP32 已支持 P2P。

## HTTP 网络采样

`GET /api/network-sample` 或 `?bytes=0` 返回 204；`bytes=1..262144` 返回相应长度的随机字节、`X-Network-Sample-Bytes` 与 identity 编码。非法、重复或超限 bytes 参数为 400。响应禁止缓存及压缩，不访问串口或代理其他地址；采样资源超限为 429。

## 注册

Local → Server：

```json
{"type":"register","version":3,"localId":"ABC23","paused":false,"ports":[{"portId":"usb","name":"USB 串口"}]}
```

五位 ID 使用 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，每 Local 恰好一个串口，portId 最多 128 字节，name 最多 256 字节。只有当前 Socket 可以释放自己的注册。初始 paused 可保留 Local 重连前的暂停意图。

确认包含 `type=register`、真实 localId、`version=3`、当前 paused 与正整数 writeEpoch（首次为 1）。Local 确认版本和写状态后才转发设备 RX。相同 ID/端口的重复注册保留暂停状态和代次；改变注册会清理旧请求与授权。

Local 发送 `{"type":"unregister"}` 停止共享，得到 unregister 确认；已授权远端收到 local_disconnected。本机页面停止共享同时关闭其传输连接，保留物理串口。

## 申请与批准

Remote → Server：

```json
{"type":"connect","version":3,"localId":"ABC23","access":"control"}
```

access 省略为 `read`，`control` 为完全控制，允许发送及在 Local 声明支持时申请修改串口参数，多个端可以同时获得。可省略 portId 选取已注册的单端口；connect 的旧 inline config 仍拒绝，参数修改必须在批准后单独发起。版本不符在注册/申请阶段返回 protocol_mismatch。

服务器向 Local 发送 connection_request，含 requestId、localId、remoteId、portId、access、expiresIn=60、version=3；向 Remote 发送 connect_pending，含同一请求与权限信息，但不含 portId/ports。此时不建立新订阅，也不返回设备数据。

Local 发送 `{"type":"approve","requestId":"...","access":"read或control"}` 或 `{"type":"reject","requestId":"..."}`。只能处理属于实际 Local Socket 的未过期请求，control 可降为 read，read 不可提升。每 Local 最多 8 个待批、16 个获批端。

批准后 Local 收到 remote_connected，含 requestId、remoteId、portId、access、grantId。grantId 等于该次随机 requestId，是新授权代次。Remote 收到：

```json
{"type":"connect","version":3,"requestId":"...","grantId":"...","localId":"ABC23","remoteId":"DEF45","portId":"usb","access":"control","paused":false,"writeEpoch":1}
```

相同待批申请复用请求与剩余有效期，不延长截止时间。已获批端重复选择相同目标/权限，得到当前授权的 connect 确认（无需 requestId），不重新审批。更换目标的申请可保留旧订阅，批准后才切换，拒绝/超时不破坏旧授权。网页在断开后重新申请。

## 数据与统一写入

Local 发送 `{"type":"data","portId":"usb","data":"AP+A"}`，服务器添加真实 localId 后广播给匹配的获批订阅者。暂停远端写入不影响 RX。

Remote 发送：

```json
{"type":"send","portId":"usb","data":"QVQN","grantId":"...","writeEpoch":1}
```

发送者须有 control 权限，端口、授权代次与当前 writeEpoch 必须匹配，Local 不能处于远端写入暂停状态。服务器转发真实 remoteId、portId、data、grantId、writeEpoch，忽略客户端声称的发送方 ID。

Local 以本机入队顺序将本机和所有获批端的数据交给同一个有界写队列。入队及执行前检查授权、端口与暂停/代次状态；撤销、暂停、断线或更换串口会阻止旧远端任务执行。每次 write 的字节连续提交，不能保证设备协议事务隔离或将 RX 自动归属于某次发送。

Local TX 日志记录驱动 write 成功后的来源与本页入队序号；取消会留下序号间隔，导出保留来源和序号。Remote TX 仅表示已提交。没有物理写入 ACK、写失败回传、离线缓存、自动重放或命令幂等键。

已获批 Remote 可发送 `{"type":"get_ports","localId":"ABC23"}`，得到 port_list 与一个端口；未获批或目标不符为 approval_required。

## 远程串口参数扩展（configProtocol=1）

v3 保留兼容的显式扩展。新版 Local 注册时增加 `configProtocol:1` 和 `serialConfig`，字段为 baudRate、dataBits、stopBits、parity、flowControl。波特率只接受 9600、19200、38400、57600、115200、230400、460800、921600；数据位 7/8，停止位 1/2，校验 none/odd/even，流控 none/hardware。缺少扩展声明的 Local 保留 v3 收发能力，但不能远程配置；部分/非法声明拒绝注册。同一注册不能用重复 register 改写已确认参数。

注册确认及获批 connect 增加 `configProtocol:1`、已确认 serialConfig、configRevision（初始 1）、configuring。只有修改中才包含 configId。待批准消息不含配置或设备元数据；只读获批端可查看实际参数。

完全控制 Remote → Server：

```json
{"type":"set_serial_config","configProtocol":1,"requestId":"edit-1","portId":"usb","grantId":"...","writeEpoch":1,"configRevision":1,"serialConfig":{"baudRate":9600,"dataBits":8,"stopBits":1,"parity":"none","flowControl":"none"}}
```

服务器校验实际订阅、control、portId、grantId、writeEpoch、暂停状态、扩展支持及 configRevision。requestId 非空且最多 128 字节，仅用于结果关联。每 Local 同时最多一个修改；不排队、不自动重试。接受后生成 128 位随机 configId，提升 writeEpoch，锁住新发送；向 Local 发 serial_config_state，随后转发 set_serial_config，附真实 localId/remoteId/portId/grantId、当前 writeEpoch/configRevision、configId 和 version=3。

serial_config_state 含版本、Local/端口、暂停/写入代次、扩展及当前已确认配置。Remote 收到的是带相同扩展字段的 write_state；因此旧 v3 Remote 也能更新写入代次。修改中 configuring=true，serialConfig 仍是原参数，不把请求当作实际配置。新版两端暂停新发送及再次修改。

Local 只在写队列为空时执行，否则报告 serial_busy。取消读取、释放读写锁后关闭并按新参数打开原设备，不重新请求浏览器设备权限，不改变共享码或正常订阅。每个异步驱动步骤前后重新校验操作标识、连接、授权、端口及暂停状态。

Local → Server，实际应用成功或已保留/恢复原参数后：

```json
{"type":"serial_config_result","configProtocol":1,"configId":"...","portId":"usb","success":true,"portOpen":true,"serialConfig":{"baudRate":9600,"dataBits":8,"stopBits":1,"parity":"none","flowControl":"none"}}
```

失败用 success=false、实际原配置及可选 code（serial_busy、permission_revoked、writes_paused、configuration_cancelled、configuration_failed）。恢复也失败用 portOpen=false。服务器只接受拥有该 configId 的实际 Local、匹配端口和未超时的结果；成功配置必须等于请求，失败且端口可用必须等于原配置。实际参数变化时递增 configRevision，完成时再次提升 writeEpoch，原授权仍有效的发起者收到 serial_config_result（附原 requestId/grantId 和最新状态），所有已授权端得到最新状态。旧发送或配置请求不能自动重放。

暂停、撤销、断线或停止共享会取消后续配置步骤；服务器发 cancel_serial_config 给 Local，锁保留到实际状态确认。已开始的驱动调用不能撤回；若取消在安全点被观察到，Local 尝试恢复原配置。物理应用已完成但确认仍在途时，最终参数可能已变更，服务器以 Local 确认的实际结果同步，不能因此恢复已撤销权限或暂停前命令。

30 秒内未能确认、端口不可用或结果矛盾时，服务器向 Local 发 sharing_stopped，并取消注册/订阅；迟到结果不能复活共享。Local 停止自动接受和重连，待驱动调用结束后尽量保留/恢复可独立操作的设备。卡住的驱动调用不能由服务器强制终止。重开可能丢弃缓冲或复位设备，硬件行为须实测。

## Remote ESP32 串口烧录扩展（flashProtocol=1）

该 v3 扩展把 Remote 页面中的 esptool-js 协议流转成获批 Local 的物理串口收发，不申请 Remote 浏览器自己的 USB 串口权限。Local 注册可声明 `serialSignalsProtocol:1`（支持 Web Serial DTR/RTS）和 `flashProtocol:1`；flashProtocol=1 要求同时声明 `configProtocol:1` 与 serialSignalsProtocol=1。Remote 在 `connect` 声明 `flashProtocol:1`。获批的 connect/state 只对双方都声明支持的连接返回 flashProtocol=1；不支持的 Local 仍保留普通 v3 收发能力。

Remote 工具要求 `control` 权限和未暂停的写状态。开始前发送：

```json
{"type":"begin_flash","requestId":"start-1","localId":"ABC23","portId":"usb","grantId":"...","writeEpoch":1}
```

服务器校验真实订阅、完全控制、能力、端口、授权和写入代次，并为该 Local 建立单个独占烧录会话，递增 writeEpoch。它向所有获批 Remote 广播 flash_state（其他 Remote 不会收到会话 ID），向 Local 发送 begin_flash。Local 仅在串口空闲、设备打开且 setSignals 可用时接受，之后用 flash_result 确认。开始期间服务拒绝所有串口写入；确认成功后，只有该会话所有者能提交 flash_send。普通 send 始终被拒绝，包括拥有会话的连接，从而防止终端数据插入 ROM 命令流。

烧录数据使用与 send 相同的非空 Base64 字节边界、单条 16 KiB 上限和授权检查，Local 仍在实际写入前重新校验会话、授权与写入代次。串口控制信号通过 set_serial_signals / serial_signals_result 成对请求，必须属于当前会话。Hub 转发给 Local 的请求带上由订阅解析出的目标 `localId` 和连接身份中的 `remoteId`；Local 校验两者与当前授权、端口和烧录会话相符，再把信号操作放入同一有界串行队列并在执行前再次校验。会话拥有者可带同一 flashSessionId 使用 `set_serial_config` 调整本地串口参数，其他 Remote 在锁期间不能修改。

Remote 每 7 秒发送 flash_keepalive；会话 90 秒未续期超时释放。WebSocket 的心跳和读写超时仍独立生效，断线不会保留烧录权限。所有者发送 end_flash 后，Local 等待已提交写入结束，再回复成功；服务器释放会话并递增 writeEpoch。所有者断开、被撤销、Local 暂停远端操作或停止共享也会释放会话，并作废旧排队项。RX 不受影响。旧版 Local/Remote 不声明扩展时不可远程烧录。

镜像选择和地址编辑在 Remote 浏览器完成，不增加服务器写文件或 Flash 地址 RPC。Remote 逐行选择 BIN 并填写每个镜像的十六进制地址，校验当前选中布局后再交给烧录库生成串口命令；修改表单会清除旧校验与确认，过期异步校验结果不得启用烧录。服务端和 Local 仍对每个串口帧校验原有会话、授权、端口及写入代次。

Remote 下载面板的 STOP 复用 `disconnect` 和连接关闭路径，中止当前远端会话并清除授权；它不是暂停后恢复，也不创建新的服务端 Flash 操作类型。

控制信号的成功、失败和超时回包均带 `requestId`、`flashSessionId`、`localId`、`portId`、`grantId` 与 `writeEpoch`，让 Remote 仅处理匹配当前授权的待完成请求。

## 暂停与恢复远端操作

Local → Server：

```json
{"type":"set_write_state","version":3,"requestId":"write-state-1","paused":true}
```

只能更新该 Local Socket 自己的注册。requestId 非空且最多 128 字节，仅用于关联状态确认。每次处理递增 writeEpoch，然后向 Local 返回 write_state（含 requestId），向所有获批 Remote 广播同样状态但省略 requestId：

```json
{"type":"write_state","version":3,"localId":"ABC23","paused":true,"writeEpoch":2}
```

暂停保留授权、连接和接收，本机在非配置修改阶段可继续发送，并关闭自动接受。暂停同时禁止新的远程参数修改并取消当前修改的后续步骤；当前配置未确定前禁止恢复。Local 在点击暂停时立即使旧远端队列项失效。发送 paused=false 请求恢复后须等服务器确认；恢复使用新代次，旧命令不得重放，远端需重新提交。已进入驱动的在途字节无法撤回。

## 撤销与断开

Local 发送 `{"type":"revoke","remoteId":"DEF45"}` 解除该端整个订阅。Local 收 remote_disconnected，Remote 收 permission_revoked 并释放连接，其他端保留权限。重新批准同一 Remote 产生新 grantId，旧队列不可复用。

Remote 的 disconnect 同时取消待批请求及现有订阅；共享端或远端离线、关闭串口、注册变更会清理相关请求与授权。短暂重连可保留 Local 的暂停意图，但不继承任何 Remote 授权。

Remote 可启用浏览器本地的断线自动重连偏好，并保存最近的 Local ID 与申请权限。WebSocket 意外断开或 Local 暂时离线后，Remote 按 3/6/12/24/30 秒退避重建连接并发送新的 `connect` 申请；每次都由服务器创建新 requestId，旧 grant、订阅和发送代次不得复用。Local 手动审批仍然有效；仅已显式开启的 Local 自动接受策略可以自动批准。用户手动断开、Local 拒绝、审批超时或资源限制关闭会停用 Remote 自动重连。上述偏好只保存在浏览器本地，不在服务端保存会话。

## 错误与资源限制

错误格式为 `{"type":"error","code":"read_only","error":"..."}`；可重试的批准失败附 requestId。常见错误：

| code | 原因 |
| --- | --- |
| protocol_mismatch | 注册/申请不是 v3 |
| invalid_message / invalid_registration | 消息、角色或注册信息非法 |
| local_id_in_use / local_not_found / port_not_available | 共享码占用、目标不存在或端口不匹配 |
| configuration_unsupported / invalid_access | 旧 inline 配置、未支持参数扩展或权限非法 |
| approval_required / not_connected / read_only | 尚未获批、未订阅或只读 |
| permission_denied / request_not_found / request_expired | 决定/撤销不属于自己，或请求失效 |
| connection_denied / approval_timeout / local_disconnected | 拒绝、过期或共享端离线 |
| too_many_requests / too_many_remotes / request_failed | 待批/获批容量限制或无法生成请求 |
| invalid_data | Base64、空字节或数据大小非法 |
| stale_grant / stale_write_state / writes_paused | 授权代次已变、写入代次已变或写入暂停，本次不转发 |
| not_sharing / invalid_write_state | 未注册的 Local 或状态请求格式非法 |
| invalid_configuration / stale_configuration | 参数格式非法，或参数代次/操作标识已过期 |
| configuration_busy / serial_busy | 另一个修改未完成，或 Local 尚有写入 |
| configuration_failed / configuration_timeout / configuration_cancelled | 设备参数修改失败、超时或已取消 |
| flash_unsupported / flash_busy / stale_flash_session | 未协商烧录能力、串口已被占用或会话已失效 |
| signals_unsupported / invalid_serial_signals / stale_serial_signals / serial_signals_timeout | 串口控制信号能力、输入、授权或请求状态无效 |

每帧最多 64 KiB，每条数据最多 16 KiB；服务端每连接输出队列最多 256 帧且 256 KiB，本机写队列最多 256 项。每 25 秒 Ping、60 秒读超时、10 秒写超时。资源超限发送固定错误后以 4008 关闭；错误码及可配置连接、IP、消息、字节与每日预算见 [资源限制](docs/RESOURCE_LIMITS.md)。协议队列满或网络失败不会静默截断后继续共享。

普通断网后 Local 按 3、6、12、24、30 秒退避重连，注册成功重置；Remote 按需重新申请。资源关闭不自动重连。v3 需同步更新两侧页面与服务端，旧版不能获得 v3 发送权限。

## 可选扩展：弱网设备 RX 补传

该扩展仍使用协议 v3。新 Local 注册时声明 `rxReplayProtocol:1`、本地串口会话的随机 128 位十六进制 `rxStreamId` 和当前 `rxSeq`；服务器确认这些值。设备每个 RX 数据帧递增序号：

```json
{"type":"register","version":3,"localId":"ABC23","rxReplayProtocol":1,"rxStreamId":"0123456789abcdef0123456789abcdef","rxSeq":0,"ports":[{"portId":"usb","name":"USB"}]}
{"type":"data","portId":"usb","rxStreamId":"0123456789abcdef0123456789abcdef","rxSeq":1,"data":"AP8="}
```

Local 若在 `register` 发出后、收到确认前继续读取到设备字节，会在确认后发送 `{"type":"rx_head","portId":"usb","rxStreamId":"...","rxSeq":N}` 更新服务器当前序号；服务器只接受同一 Local/port/stream 的单调递增值，并向已有订阅显式发送缺口。

支持补传的 Remote 在 `connect` 中声明 `rxReplayProtocol:1`，并可携带内存中保存的 `resumeStreamId` 和最后连续收到的 `resumeSeq`。服务器只在 Local 批准且流 ID 相同时请求补传；请求包含实际 Remote 身份、当前 grant、串口和 `throughSeq`。新 Remote、刷新过页面的 Remote 或流 ID 已变化时从当前 RX 序号开始，不回传历史数据。Remote 必须重新申请并获批后才可续传。

Local 最多在内存中保留 1 MiB、8192 帧、30 秒的 RX。它按序号向单个获批 Remote 发送 `replay_data`，补传上传速率最多 128 KiB/s、突发 32 KiB；Remote 对已收到的数据返回单调递增的累计 `rx_ack`，确认值可落后于当前已发送窗口，服务器拒绝尚未发送序号的确认。缓存已过期或被覆盖时，Local 先发送 `replay_gap`，Remote 会将缺口写入接收记录并显示。全部可用帧确认后，Local 发送 `replay_complete`。服务器在补传期间为该 Remote 暂存后续实时 RX，最多 192 KiB；补传完成后按序发送。补传队列超限会断开该 Remote，连接需重新申请，不能静默漏过实时帧。

RX 缓存只存在于当前 Local 页面内存，停止共享、关闭串口、刷新 Local 或更换串口会清除；它不写服务器磁盘。TX 命令永不缓存或自动重放。任何一方未声明该扩展时，仍可使用 v3 实时收发，但不会执行 RX 补传。

扩展错误码：`invalid_rx_sequence`、`invalid_rx_resume`、`invalid_rx_replay`、`invalid_rx_ack`；补传期间队列超限使用 `send_queue_limited`。
