# ShareSerial 维护约束

适用于本仓库内的人工和 AI 维护。用户在当前会话中的明确要求优先。

## 产品边界

- 保持 Go + Gin + gorilla/websocket、原生 HTML/CSS/JavaScript 的轻量实现。
- 每个 Local 页面操作一个串口，可独立调试或开启共享；Remote 由 Local 手动或按显式开启的自动接受策略批准，默认申请只读。
- Local 与多个获批可发送 Remote 使用同一有界串口写队列；Local 可暂停全部远端写入，保留远端接收并关闭自动接受。暂停、撤销、断线后的旧排队命令不能恢复执行。
- 串口由 Local 实际操作；显式支持远程配置的 Local 可执行已获完全控制权限 Remote 的参数修改，只读端不得修改。变更须校验授权/参数代次、串行处理、确认实际结果并处理取消与回退；参数未确定时不得继续共享。模型见 docs/ACCESS_CONTROL.md；账户体系需要独立设计。
- 当前面向受信网络、自托管调试。不得把五位 ID 描述为密码或宣传为可直接开放公网的服务。

## 实现约束

- Hub.Run 独占连接状态、ID、订阅和发送通道的关闭操作；读写泵只处理网络 IO。
- 每个 WebSocket 只允许一个读取协程和一个写入协程。不要增加并行写入或无界队列。
- 身份来自连接，消息内的 localId/remoteId 不得覆盖发送方身份。
- 申请不等于授权。待批准状态不得创建订阅；批准/拒绝/撤销必须校验实际 Local 连接，过期请求不得复用。
- 服务端逐条校验发送授权与当前写入状态；Local 在入队和实际写入前都校验授权代次、端口及暂停状态，撤销或暂停立即停用旧队列项。
- 连接成功前先校验目标；转发必须匹配 Local 和 portId；断开必须清理订阅并通知对端。
- 保留同源检查、消息大小限制、心跳和写超时；不得恢复 CheckOrigin 恒为 true。
- 数据按字节保真，HEX 输入必须校验；串口文本跨分片使用流式解码。
- 不提交证书、私钥、编译产物、实际串口日志或 .local 目录。
- 不引入外部 CDN、遥测、前端框架或新运行依赖来解决简单问题。

## 文档与验证

- 协议变更同步更新 PROTOCOL.md、中文/英文 README 和 CHANGELOG.md。
- 文档只描述已实现且已验证的行为；计划放入 ROADMAP.md。
- 缺陷修复应有可复现步骤或有意义的回归测试，尤其是状态生命周期、串口字节和权限边界。
- Go 最低版本以 go.mod 为准；Node.js 24 用于测试，无 npm 依赖。
- 提交前运行 gofmt、go vet ./...、go test ./... 和 node --test tests/serial-data.test.cjs tests/browser.test.cjs tests/access.test.cjs tests/network-reference.test.cjs tests/mutation-runner.test.cjs tests/i18n.test.cjs。
- 涉及连接并发必须运行 go test -race ./...；环境无法运行时说明原因，由 Linux CI 验证。
- 修改身份校验、串口路由、生命周期或字节转换后运行 node scripts/mutation-test.cjs；规则见 docs/MUTATION_TESTING.md。
- 变异测试基线必须先通过；编译失败、超时和环境错误不得计为检出，不得为提分删去存活变异或降低门禁。
- 硬件联调与浏览器实际权限验证不能用 mock 测试的结果替代，未做必须明确记录。
- 每次变更保持可审查范围，不顺带加入未验证功能或重写 Git 历史。
