# 安全边界 / Security

当前维护基线面向受信网络中的自托管串口调试。Remote 需经共享端逐次批准，默认只读，可批准多个发送端与 Local 统一排队。仅知道五位 Local ID 不能读取设备详情、串口数据或写入设备，但仍可发起连接申请。五位 ID 用于定位会话，不是密码，也不证明申请者的真实身份。

Local 默认手动批准。显式开启“自动接受申请”后，能访问服务并提供共享码的申请者可按所申请权限自动获批，包括多个发送端；这不构成人员身份认证。停止共享、关闭串口、刷新页面或暂停远端发送会关闭该选项。短暂重连仍对新请求重新审批，不继承旧授权，并保留 Local 的暂停意图。

## 已实现边界

- WebSocket 使用同源检查。没有 Origin 的非浏览器客户端仍可连接，同源检查不替代身份认证。
- 发送方身份由连接决定，消息不得冒用其他连接的 ID。
- 批准/拒绝/撤销由实际共享端连接决定；128 位随机 requestId 用于关联一次请求，不是访问凭据。请求 60 秒过期，不继承网络重连前的授权。
- 每个 Local 最多 8 个待批准请求和 16 个已授权连接。只读端写入会被拒绝，多个可发送端与本机共用有界队列。
- 服务端和 Local 校验授权代次与写入状态；暂停/恢复提升 writeEpoch，重新批准生成新 grantId，旧队列不能复活。Local 在入队和执行前重新检查。已交给设备的在途字节无法撤回。
- 完全控制权限也包含串口参数修改；自动接受控制申请会授予同一能力。Local 必须显式声明配置支持。服务端与 Local 校验真实订阅、端口、授权/状态及参数代次；一次一个修改，失败恢复原参数，超时或实际状态不明则停止共享。取消在驱动调用之间生效，不能撤回已开始的关闭/打开调用。
- 串口转发匹配订阅中的 Local 和 portId；非法角色消息、非法 Base64 和超大帧会被拒绝。
- 每帧上限 64 KiB，每条串口数据最多 16 KiB 原始字节；每客户端发送缓冲 256 帧，积压会断开慢客户端。
- 心跳、读写超时和断线清理限制失效连接的存活时间。
- 命令行服务模式默认仅监听 127.0.0.1；Windows 局域网入口在用户配置地址和端口后监听局域网，证书信任与专用网络防火墙更改均须明确确认。其他局域网部署可显式使用 -addr 并配置可信证书。
- 连接准入、跨连接/IP 的申请/消息/HTTP 速率、应用字节预算、每日中继/采样预算和队列字节限制见 [资源限制](docs/RESOURCE_LIMITS.md)。默认不信任转发 IP 头，反向代理必须显式配置可信地址。

这些边界不提供端到端加密。HTTPS/WSS 的 TLS 在转发服务器终止，服务器能够读取转发的串口数据。没有账户或人员身份认证；IP/NAT 额度不等于按人配额，进程重启会重置预算。资源限制不能替代网络层防护或安全审计，也不能保证匿名使用者之间的公平性。公网部署需要正确的代理配置、受信任 HTTPS 和运维资源预算，当前版本不能宣称已经完成大规模公网或持续硬件压力验收。

## 证书与历史

开发证书必须在每个环境单独生成，不提交私钥。Windows 局域网发布包还可为具体服务器生成独有的非 CA 证书，由使用者核对指纹并逐台建立信任；证书只覆盖配置中的服务器地址，不作为公共 CA 证书使用。信任导入必须明确确认，只针对当前 Windows 用户。其他部署配置受信任的组织或公共 HTTPS 证书，详见 [发布包部署](docs/DEPLOYMENT.md)。

仓库旧提交包含开发证书、私钥和编译产物。当前工作树已将它们移出源码目录，但历史仍保留旧文件。旧私钥应视为公开，曾使用它的部署必须换新密钥和证书。重写历史需要维护者单独决定，不能代替密钥轮换。

## 报告安全问题

当前尚未建立专用私密举报邮箱。请通过托管平台提供的维护者私信渠道联系仓库维护者，请求私密报告方式；不要在公开 Issue 中提交密钥、攻击脚本、真实设备日志或仍可利用的细节。公开 Issue 可以仅写“需要安全报告渠道”。

正式发布前应建立并验证专用私密报告渠道。当前没有正式发布的安全支持版本或响应时限承诺。

English: Local approval is required; readers cannot write or configure, and full-control Remotes share Local's bounded FIFO and may request supported parameter changes. Local confirms physical changes; uncertain or timed-out configuration stops sharing. Grant/write generations prevent stale commands after revocation or pause/resume. IDs do not authenticate people. Anonymous connection, IP/rate/byte/queue and daily budget limits are implemented; account authentication and network-layer protection are not. TLS terminates at the relay. Historical private keys must be rotated. Contact the maintainer privately before disclosure.
