# 变异测试结果记录

本文件保留第一轮 46 项清单历史及后续扩展记录。最新清单范围见 MUTATION_TESTING.md，授权轮次验证见 ACCESS_VALIDATION.md。

日期：2026-10-15。本记录来自三次实际完整运行，范围为当前 46 个定向变异，不是穷举 AST 变异。

## 逐轮结果

| 轮次 | 总数 | 检出 | 存活 | 无效 | 超时 | 环境错误 | 得分 | 门禁 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 首轮：原有测试 | 46 | 29 | 17 | 0 | 0 | 0 | 63.04% | 失败 |
| 第二轮：补用例与空数据修复 | 46 | 45 | 0 | 0 | 1 | 0 | 100.00% | 失败 |
| 最终：同步断言修正 | 46 | 46 | 0 | 0 | 0 | 0 | 100.00% | 通过 |

得分只统计 killed / (killed + survived)。第二轮虽然分数为 100%，但存在一个超时，门禁正确失败；未将超时计为检出。

## 实际发现与修复

- 首轮 17 个存活项证明原有测试存在断言缺口。新增注册长度/字符/数量/字段边界、上下行非法 Base64、Local 串口匹配、HEX 奇数位/补零、Remote 离线/串口过滤、过期 ACK、写队列边界和注册前数据处理用例。
- 负向用例发现实际缺陷：Go Base64 解码器允许 CR/LF，只有 CR/LF 的输入会解码为空字节；原校验仅拒绝空字符串，因此会转发无数据消息。现已拒绝这类输入，并保留全零二进制数据与 16 KiB 上限的正向用例。
- 第二轮 go-premature-subscription 触发多个同步测试各等待两秒，累计达到包级 15 秒超时。现将同步注册/连接测试改为立即检查响应；异步 Hub/socket 测试仍保留有界等待。未提高超时或放宽计分规则。
- 全清单前后均为 46 项，未删除存活项。空数据缺陷修复后，go-empty-data 的定位锚点随校验代码更新，故清单哈希改变；其故意放过空数据的变异意图保持不变。

## 验证环境与可追溯信息

- Go：go version go1.25.14 windows/amd64
- Node：v24.20.0
- 最终工作树源码/测试指纹：`8bbda63ee348c608aa0bbdc9ecfece8ba3b2eadb0b1592cbb2a376f4309ee2a6`
- 最终清单 SHA-256：`57fc5687e519d2bf22fdd58d7905c97e7a4364fc4173d1b93f93ed6e11221b61`
- 首轮清单 SHA-256：`7127f675fb8481081a2c1ae0993377cc4700080e55b6e9efa195ecee6bda730b`
- 最终执行器 SHA-256：`3695be380a6c5107606181833b064cbc2b626e47103c1732e27dc63959a99643`
- 原始 JSON、Markdown、逐项日志分别保留于 .local/mutation-initial、.local/mutation-final（第二轮）、.local/mutation-report（最终）。这些为本地验证产物，不提交仓库；CI 会上传自己的运行报告。
- 27 项 Node 测试通过，其中 19 项产品测试、8 项执行器测试。执行器自身的测试不参与产品变异得分。
- Go 普通测试、go vet 与 WSL/Linux race 检查通过。
- 执行器超时终止 smoke 检查通过；这不计入变异得分。

## 首轮存活项

| ID | 最终结果 | 最终检出测试（节选） |
|---|---|---|
| go-id-length | killed | shareserial/websocket/TestRegistrationBoundaries/empty_id |
| go-id-alphabet | killed | shareserial/websocket/TestRegistrationBoundaries/lowercase_id |
| go-registration-count | killed | shareserial/websocket/TestRegistrationBoundaries/two_ports |
| go-empty-port | killed | shareserial/websocket/TestRegistrationBoundaries/empty_port |
| go-port-id-length | killed | shareserial/websocket/TestRegistrationBoundaries/long_port_id |
| go-port-name-length | killed | shareserial/websocket/TestRegistrationBoundaries/long_name |
| go-local-port-check | killed | shareserial/websocket/TestLocalDataMustMatchRegisteredPort/wrong_port |
| go-local-base64-check | killed | shareserial/websocket/TestPayloadValidationBothDirections/data/empty |
| go-empty-data | killed | shareserial/websocket/TestPayloadValidationBothDirections/data/empty |
| go-base64-padding-bits | killed | shareserial/websocket/TestPayloadValidationBothDirections/data/nonzero_padding_bits |
| js-hex-odd-length | killed | HEX accepts whole bytes and rejects malformed input |
| js-hex-no-padding | killed | HEX display preserves leading zeroes and uppercase byte boundaries |
| js-ignore-local-disconnect | killed | Local disconnect notification resets Remote state while transport stays open |
| js-ignore-data-target | killed | Remote accepts only RX for its current Local and port |
| js-stale-registration-ack | killed | Local ignores a previous registration ACK and accepts the current one |
| js-write-queue-off-by-one | killed | Local accepts 256 queued writes and closes the transport on the 257th |
| js-forward-before-register | killed | Local forwards registered reads in bounded byte-preserving chunks |

## 边界

最终 46 个变异全部有具体失败测试，未用语法/编译失败、超时、环境错误或执行器自身的文件检查凑检出数。该结论不替代真实串口硬件、浏览器权限、公网鉴权、物理写入确认或未列入清单的其他缺陷验证。

执行方式与后续维护规则见 [MUTATION_TESTING.md](MUTATION_TESTING.md)。

## 后续扩展：Local 串口助手

2026-10-15，保留此前全部 74 个变异的原意并更新重构后的定位锚点，新增 9 个前端变异。首轮结果为 82/83，`js-take-control-keeps-auto` 存活：已有控制者场景中，撤销辅助函数也会关闭自动接受，原断言没覆盖批准尚未确认的分支。

新增“待批准控制尚在途中时收回”的断言，要求自动接受关闭、迟到批准不能恢复权限，且后续申请不会自动批准。单项复查检出后，重跑完整清单得到 83/83，存活/无效/超时/环境错误均为 0。没有删除存活项或放宽门禁；该结果仍只针对定向清单，不代表全部缺陷。

## 后续扩展：页面网络参考

2026-10-16，新增 8 项，合计 91 项。首轮 90/91，网络响应大小上限变异存活：handler 单元测试覆盖了该边界，但 `go-server` 变异子集只执行主包测试。补上通过实际路由请求最大值及超限值的集成用例后，单项复查检出，完整重跑 91/91，存活/无效/超时/环境错误均为 0。保留全部变异，未放宽门禁。

## 后续扩展：网络参考失败诊断

2026-10-16，新增探测等待过短、下载等待过短、隐藏 HTTP 失败状态 3 项，保留原有清单，完整运行 94/94 检出，存活/无效/超时/环境错误均为 0。回归用例包含 2 秒往返、6 秒下载和“5 次超时加 1 次网络错误”，确认慢响应仍可测量，样本不足不会输出波特率，认证错误不被描述为丢包。原始结果保存在 `.local/mutation-network-diagnostics-fix`。

## 后续扩展：免账号资源治理

2026-10-16，保留此前 94 项原意并调整重构后的 6 个定位锚点，新增全局/每 IP 连接、跨连接尝试、HTTP 请求、全局/IP 字节、每日预算、IP 状态表、共享码查找、转发副本、队列字节和 Remote 空闲连接共 12 项。隔离副本包含资源包与路由集成测试，`go-server` 子集执行所有 Go 包，避免漏掉资源单元断言。

为补齐“资源错误到达至 Socket 关闭前”的排队写入断言曾主动中止一次运行，不计分。最终源码完整运行 106/106，存活/无效/超时/环境错误均为 0；执行器未放宽门禁。原始报告为 `.local/mutation-public-resource-final`，源码/测试指纹为 `0e20a85e6ab3bd463807482f980f9b313f86aafd3182004b7329e752bbb9dfd8`。

## 后续扩展：v3 多发送端队列

用户将权限模型改为多个可发送端与 Local 统一排队。原独占控制相关变异调整为“重新引入独占限制”的回归故障，关闭串口的队列检查改为共用执行器的故障，保留其他原意并更新定位锚点。新增授权/状态代次、暂停、旧版兼容、状态所有权、并行写入、来源日志和 Remote 暂停检查共 13 项，合计 119 项。

首轮 116 检出、2 存活、1 编译无效，且执行期间测试输入变化，门禁失败。端口变异被缺失授权代次的测试输入掩盖，补为合法授权上下文并检查精确错误码；重复连接变异保留变量引用以避免编译无效。行尾大小变异因共用队列新增第二道校验而存活，现同时禁用两道检查，保持“允许超大行尾数据写入”的原故障意图。

单项复查 3/3 后完整重跑，最终 119/119，存活/无效/超时/环境错误均为 0，输入未变化，未放宽门禁。原始记录为 `.local/mutation-multiwriter`、`.local/mutation-multiwriter-recheck`、`.local/mutation-multiwriter-recheck-final` 和 `.local/mutation-multiwriter-final`。

## 2026-10-20：弱网 RX 补传

完整清单扩展到 161 项。新增 11 项检查 RX 缓存字节/帧/时间上限、重复序号过滤、补传 ACK 窗口、注册确认前不转发、Hub 单调序号、grant 校验、补传期间实时帧顺序、服务端待发队列上限及 ACK 顺序。

Go 与前端基线通过；161/161 变异均检出，存活/无效/超时/环境错误为 0，门禁通过。Go `go1.25.14 windows/amd64`、Node `v24.20.0`；当次源码指纹 `34c8200fc3096a19607c2a8d67568d7c2f077f031c8e940dedfe1488daeeaec8`。完整 JSON、Markdown 与逐项日志保存在忽略目录 `.local/mutation-rx-complete/`，未提交到仓库。

## 2026-10-21：RX 压力复核与门禁

真实 COM5/COM6 压力复核发现 256 帧上限会把 262144 字节的小块串口读取压缩到仅 42340 字节；增加 8192 帧上限和“169 字节读取可覆盖 1 MiB 缓存”回归测试。八帧并发补传还暴露累计 ACK 校验过严：Hub 可能已发送完整窗口，却在收到较早有效 ACK 时拒绝连接。现在接受单调递增且不超过已发送序号的累计 ACK，仍拒绝未来序号。无节制高速补传还会耗尽每来源字节预算，因此 Local 现在以 128 KiB/s、32 KiB 突发节流补传。

多 Remote 实时扇出计费回归由 `TestRXLiveFanoutChargesEveryCopyToLocalSource` 覆盖。RX 补传及限速新增两项变异，完整清单现为 163 项；Go 与前端基线通过，163/163 检出，存活/无效/超时/环境错误均为 0，门禁通过。Go `go1.25.14 windows/amd64`、Node `v24.20.0`；当前源码/测试指纹 `62ef8ebe51e85976a023611724392a97aaf3ac4f1fab26e0945c84145c0d9f98`，清单 SHA-256 `4c05c626390ceeaf8fb23d85bb43bf5e2d927dd24c9e387e70a2118d8ac333e9`。完整报告与逐项日志保存在忽略目录 `.local/mutation-rx-final/`，未提交到仓库。

同一工作树下 `go vet ./...`、`go test ./...`、WSL/Linux `go test -race ./...` 和规定的 5 个 Node 测试文件均通过（94 项）。实机压力结果与剩余公网限带宽验证见 [ACCESS_VALIDATION.md](ACCESS_VALIDATION.md)。

## 2026-10-21：Remote ESP32 工具箱

增加 5 项清单安全变异，覆盖设备芯片匹配、未声明镜像、Flash 越界、镜像重叠及 SHA-256 校验。Go/前端基线通过，168/168 检出，存活/无效/超时/环境错误均为 0。Go `go1.25.14 windows/amd64`、Node `v24.20.0`；源码指纹 `43e2a0125ddecde8c0191556717714c33085f5a8a84476317ec1f5ae285b4822`，清单 SHA-256 `aeae735ceff76322c70147db491d03768a53546153683f85c0df27cd6ebfc9e5`。完整报告与逐项日志保存在忽略目录 `.local/mutation-esp32/`，未提交到仓库。

真实 Chrome Web Serial 权限选择了 COM7，Espressif esptool-js 检测到 ESP32-S3 QFN56 revision v0.2 和 8 MiB Flash；本轮使用本地探针镜像验证了清单/哈希 UI，烧录按钮保持禁用，没有写入设备。记录保存在 `.local/deployment/esp32-com7-browser-smoke.json`。实际固件写入、复位启动和断线恢复仍待对应固件镜像及硬件验收。

## 2026-10-21：Remote 共享串口 ESP32 会话

将 ESP32 工具改为通过共享码操作 Local 的物理串口后，新增 4 项变异，覆盖普通写入不能穿过烧录锁、只有会话所有者能提交 Flash 帧/控制信号，以及暂停远端操作会释放锁。完整清单 172/172 检出，存活/无效/超时/错误均为 0；Go 与前端基线通过。Go `go1.25.14 windows/amd64`、Node `v24.20.0`；源码指纹 `6a96d33e1b20b7a808ec1324308e2a4b97a47dac17bf7683c6849fdf29f06eb5`，清单 SHA-256 `b1438e07a1a1e963e9d64c73e07880dcf7c9e8bac43c869678e2dac3d15fa3f7`。完整报告与逐项日志保存在忽略目录 `.local/mutation-remote-flash-final/`，未提交到仓库。

同一工作树 `go vet ./...`、`go test ./...` 及 Node 105 项测试通过。Windows 上 `go test -race ./...` 因缺少 cgo C 编译器无法运行；GitHub Linux CI 会执行 race 检查。实际 COM7 链路联调中，Web Serial 枚举到授权设备后 `SerialPort.open()` 失败，没有进入芯片检测或固件写入；失败记录位于忽略目录 `.local/deployment/remote-flash-hardware-smoke-failure.json`。

## 2026-10-22 公网联调超时与控制信号回包

为远程串口包读取增加 10 秒最小等待，保留更长的擦除/写入预算；新增回归使用固定版本的真实烧录库，验证晚于直连 USB 100 ms 等待的 ROM SYNC 回复仍能接收，并验证长操作预算和错误继续传递。控制信号超时结果补齐 Local、端口、授权与代次字段，由 Go 回归检查，避免 Remote 将匹配的超时结果误当成旧授权而忽略。

`go vet ./...`、`go test ./...` 与 Node 107 项测试通过。完整变异基线通过，172/172 检出，存活/无效/超时/环境错误均为 0；源码/测试指纹 `605c7ef7f851ee0aaa8b6c18260608545f47c952cb420e4d69a66d2d97074ad8`，清单 SHA-256 `b1438e07a1a1e963e9d64c73e07880dcf7c9e8bac43c869678e2dac3d15fa3f7`。Go `go1.25.14 windows/amd64`、Node `v24.20.0`；完整报告位于忽略目录 `.local/mutation-public-signals-final/`。Windows 缺少 GCC，race 仍由 Linux CI 验证；硬件验收状态见 [ESP32_FLASHING.md](ESP32_FLASHING.md) 与 [ROADMAP.md](../ROADMAP.md)。

## 2026-10-22 烧录慢网适配

压缩块缩至 2 KiB，协议包读取等待下限增至 30 秒，会话续期窗口增至 90 秒；浏览器发送积压超过 64 KiB 时停止提交新帧。新增回归用真实烧录库验证延迟 ACK 不会提前发送下一块、压缩分块字节可完整还原，以及积压/暂停后拒绝发送。Go 模拟时钟回归覆盖延迟续期、过期授权不能续期、超时释放与拒绝迟到写入。

`go vet ./...`、`go test ./...`、WSL Ubuntu 26.04 下 Go 1.25.14 `go test -race ./...` 与 Node 109 项测试通过。完整变异基线通过，172/172 检出，存活/无效/超时/环境错误均为 0；源码/测试指纹 `98e60552868e5114758a066a77f6ff0b02074224d6a59f842b780de60dedfc15`，清单 SHA-256 `b1438e07a1a1e963e9d64c73e07880dcf7c9e8bac43c869678e2dac3d15fa3f7`。完整报告位于忽略目录 `.local/mutation-flash-slow/`。硬件测试结果另记于 [ESP32_FLASHING.md](ESP32_FLASHING.md)。

## 2026-10-22 手动烧录地址与校验代次

新增四项变异：忽略手动地址、放宽镜像分配上限、编辑地址后保留旧确认，以及异步校验完成后恢复过期地址。回归覆盖手动布局字节与实际交给烧录库的偏移、清单地址编辑、取消勾选、重叠/未对齐/越界、文件大小、表单修改及断线后的迟到结果。

`go vet ./...`、`go test ./...`、WSL Ubuntu 26.04 下 Go 1.25.14 `go test -race ./...` 与 Node 117 项测试通过。完整基线通过，176/176 检出，存活/无效/超时/环境错误均为 0；源码/测试指纹 `9f40ea10e984850a62fff0716a4decb8a923617cd1727ea56b794b3b7910808b`，清单 SHA-256 `ef86ae08542e6ec9a04fa6413750a48b7f0fe3adbe0798475e1395ed342be081`。原始报告位于忽略目录 `.local/mutation-manual-flash/`。

真实 Chrome 检查了桌面和 390 px 页面、清单地址编辑、手动布局、重叠拒绝和确认失效；此界面测试模拟串口状态，没有实际写入设备。另一轮真实 Web Serial 测试未能打开系统可见的 COM7，未进入芯片检测或烧录；本轮手动模式的硬件验收未完成，不能用模拟结果替代。此前公网 S3 完整烧录结果对应旧的清单模式版本，详见 [ESP32_FLASHING.md](ESP32_FLASHING.md)。

## 2026-10-22 SPIDownload 面板布局

默认显示 8 行文件选择、勾选和地址输入，集中 SPI/检测配置及 START/STOP 下载区。每行可独立选择文件并保留先填的地址；清单行继续校验原文件名和 SHA-256。新增回归覆盖逐行文件选择、清单行替换文件的哈希检查和忙时 STOP 清除授权，原有地址及异步代次回归保留。

`go vet ./...`、`go test ./...`、WSL/Linux `go test -race ./...` 与 Node 120 项测试通过。完整基线通过，176/176 检出，存活/无效/超时/环境错误均为 0；源码/测试指纹 `d17d2e9d9752fd9db98da33f80d867245190250a8ce4ece2fbec831eaf004ab7`，清单 SHA-256 `ef86ae08542e6ec9a04fa6413750a48b7f0fe3adbe0798475e1395ed342be081`。报告位于忽略目录 `.local/mutation-fdt-style/`。

真实 Chrome 验证默认 8 行、逐行原生文件选择、地址保留、重叠拒绝、确认失效与 STOP 流程，桌面 START 可见且 390 px 页面无整页横向溢出；串口状态采用测试模拟，本轮没有烧写设备。

## 2026-10-22 BIN 专用入口与统一样式

移除页面来源选择、JSON 文件入口及导入处理分支。原导入界面用例改为 BIN 取消勾选、替换后重新计算摘要，以及断线后丢弃迟到的文件哈希结果；底层布局/摘要校验和全部 176 项核心变异继续保留，未降低门禁。

`go vet ./...`、`go test ./...`、WSL/Linux `go test -race ./...` 和 Node 121 项测试通过；完整基线通过，176/176 检出，存活/无效/超时/环境错误均为 0。源码/测试指纹 `866127f282220a05c2dc45c3f0dd51c9af4bdcdf1f396fb8028c1050c7916da0`，清单 SHA-256 `ef86ae08542e6ec9a04fa6413750a48b7f0fe3adbe0798475e1395ed342be081`；报告位于忽略目录 `.local/mutation-simple-esp32/`。

真实 Chrome 检查无导入入口、逐行与批量 BIN 选择、重叠拒绝、确认失效、停止流程和桌面/390 px 布局；实测计算样式与现有页面的青绿色按钮、6 px 圆角及深色日志一致。包含 bootloader 的 273312 字节合并 BIN 在 `0x0` 的单文件页面校验通过；串口状态采用测试模拟，本轮未进行硬件烧录。
