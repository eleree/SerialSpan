# 发布包部署

Windows 交付为一个可直接运行的 EXE。页面、转发服务、首次配置、证书生成及许可证都在同一个文件中；不需要解压辅助程序或启动脚本，也不需要 Go、Node.js、Python、PowerShell、Docker 或 WSL。

当前为受信网络中自托管调试的预览版。编译成功不等于完成全部操作系统、浏览器和串口硬件验收；状态见验证记录及 [ROADMAP.md](../ROADMAP.md)。

## Windows 局域网

1. 将 `ShareSerial-v<版本>-windows-amd64.exe` 复制到普通 Intel/AMD Windows 电脑。ARM Windows 使用 `windows-arm64.exe`。当前产品版本以仓库 `VERSION` 文件为准。
2. 双击 EXE，在首次运行窗口输入这台服务器的局域网 IPv4 地址或域名，以及访问端口。窗口列出可用网卡地址；不要选择断开或虚拟机网卡。
3. 程序在当前用户目录生成独有的 365 天非 CA 服务器证书，并显示 SHA-256 指纹。明确输入 `YES` 后，才将该证书加入当前 Windows 用户信任；其他输入跳过。
4. 如确认配置局域网入站防火墙，Windows 会请求管理员授权。同一个 EXE 完成配置，规则只允许专用网络中本地子网访问该程序及端口，不开放公用网络。组织策略不允许时，请管理员配置。
5. 程序显示并打开访问地址。设备电脑打开 `/local`，远端打开 `/remote` 或 `/remote/esp32`，申请连接并等待 Local 批准。保持窗口运行，Ctrl+C 或关闭窗口停止同一个服务进程。

数据默认保存在 `%LOCALAPPDATA%\ShareSerial`，与 EXE 所在位置无关：

- `config.json`：地址、端口与证书路径。
- `certs-<随机值>/`：本机生成的证书和私钥。
- `ShareSerial-LAN.cer`：可向其他电脑分发的公开证书。

其他电脑需要核对并信任公开 CER：双击证书，选择“安装证书 → 当前用户 → 受信任的根证书颁发机构”。特别是操作 Local 串口的电脑，必须有可信 HTTPS 和支持 Web Serial 的浏览器；仅跳过浏览器证书警告不构成验收。只分发公开 CER，不能发送私钥或整个配置目录。

这套局域网证书由使用者自行建立信任，不是公共 CA 证书；共享码仍只是会话定位符，不提供人员身份认证。

## 更新与配置

更新时停止旧程序，换用新的 EXE 即可。原用户目录中的配置和证书保留，重命名或移动 EXE 不会丢失它们；可执行文件路径改变后需重新核对防火墙规则。

IP 改变、证书过期或更换域名时，先停止服务，再运行预编译程序的配置入口：

```powershell
.\ShareSerial.exe -lan -configure
```

旧配置保存在 `config.previous.json`，旧证书目录保留。各客户端需核对并信任新证书；不再使用的旧信任可在 Windows 证书管理器中按指纹移除。

已有组织证书时，在停机状态下修改 `config.json`：

```json
{
  "listenAddress": "0.0.0.0:12345",
  "publicHost": "serial.example.internal",
  "port": 12345,
  "certificate": "certs/fullchain.pem",
  "privateKey": "certs/key.pem",
  "certificateMode": "provided",
  "openBrowser": true
}
```

相对路径以用户配置目录为基准，也支持明确的绝对路径。`provided` 模式不生成证书或导入信任，证书必须覆盖访问域名且与私钥匹配；端口、有效期、域名和私有局域网证书指纹在启动前校验。

维护命令均直接运行 EXE，不需要开发工具：

```powershell
.\ShareSerial.exe -version
.\ShareSerial.exe -licenses
.\ShareSerial.exe -lan -help
```

`-licenses` 直接读取 EXE 中的许可声明，不创建许可证目录。此前 ZIP 中的 `licenses/go` 也是许可证，不是 Go 源码。

旧 ZIP 配置不会被静默迁移。需要继续使用旧目录时，可在停机后运行 `ShareSerial.exe -lan -data-dir "旧 ZIP 解压目录"`，相对证书路径仍以该目录为基准。未指定时使用新的当前用户目录。

当前入口运行于用户会话，控制台显示日志，退出用户会话或关闭窗口停止服务；尚未提供系统服务安装或开机自启。文件尚未做 Authenticode 签名，组织应用控制与 SmartScreen 准入需独立验收。

## Linux / macOS

需要跨网尝试串口直连时，可在原服务参数上增加 `-stun-urls stun:stun.example.com:3478`，多个地址用逗号分隔，最多四个。默认不配置外部 STUN；客户端从同源配置脚本自动读取，无需增加页面操作。STUN 服务需要其 UDP 端口可达；它只提供地址发现，不转发串口数据，也不保证复杂 NAT 直连。直连失败继续使用 WSS，当前不支持 TURN 配置。Windows 使用原始 `-addr/-cert/-key` 服务参数启动时也可指定同一标志；默认局域网向导不增加配置步骤。

这两个平台继续提供 `.tar.gz`。解压，准备可信证书后运行包内脚本：

```sh
SHARESERIAL_ADDR=0.0.0.0:12345 \
SHARESERIAL_CERT=/path/fullchain.pem \
SHARESERIAL_KEY=/path/key.pem ./start.sh
```

包内提供编译好的 `tools/shareserial-cert`，可为明确自行管理信任的局域网生成证书；参数见 `README.txt`。运行不需要编译器，macOS 文件尚未签名或公证。

## 维护者构建与 GitHub 发布

此段只针对维护者，不是交付给用户的运行步骤。Windows 的主程序可直接编译并交付：

```sh
go build -o ShareSerial-v0.1.0-beta.1-windows-amd64.exe .
```

这个文件就是可部署程序。网页与许可证都通过 `go:embed` 在编译时纳入，不需要额外的封装、追加数据、压缩或解压步骤。默认双击进入局域网配置，也可传入原有服务端参数。

`VERSION` 是唯一产品版本来源。普通编译的 `-version` 和 Windows 启动信息也会显示该版本，不再默认显示 `dev`。正式交付使用下面的发布构建，补齐 Windows 文件属性的版本信息：

```sh
go run ./cmd/package -out dist
```

`dist/<版本>/` 包含 Windows amd64/arm64 的两个独立 EXE、Linux/macOS amd64/arm64 的四个归档，以及 `SHA256SUMS.txt`。`-targets native` 只构建当前目标；已有版本目录不会覆盖，失败不发布半套目录。

文件名、CLI、启动提示和 Windows 的文件/产品版本来自同一 `VERSION`。Windows 版本属性通过编译前生成的标准 VERSIONINFO 资源由 Go 链接器合入，临时 `.syso` 在编译后清理，不提交或分发。最终 EXE 仍是编译器输出，编译后不补丁修改。预发布同时设置 Windows 的预发布标记；`0.1.0-beta.1` 的数值版本为 `0.1.0.1`，显示字符串保留完整语义版本。

版本升级时先修改 `VERSION`，再更新 CHANGELOG。显式 `-version` 或 Git 标签与 `VERSION` 不一致会拒绝发布构建，防止下载文件与程序内版本不同。

多平台发布工具仅复制 Go 编译器生成的 Windows EXE，字节内容保持一致；不在 EXE 尾部追加归档。版本由 Go 的构建信息和可选链接参数提供，程序不读取自身文件来加载资源。其他平台归档采用明确文件清单；均不包含预生成的证书、私钥、实际日志或 Go 源码。

`THIRD_PARTY_NOTICES.txt` 是提交到源码仓库的公开许可证资源。维护者更新依赖后执行 `go run ./cmd/package -sync-notices` 并提交更新，正常 `go build` 不需要执行这个步骤。发布工具会检查各目标依赖的许可证与编译资源一致。

构建信息记录版本、目标、Go 版本、提交及工作树是否有未提交改动。Go、使用的 Go 模块和浏览器库的许可证一并保留。

[release.yml](../.github/workflows/release.yml) 支持手动构建后上传 artifact，以及推送 `v<版本>` 标签后创建草稿预发布。都先通过跨平台 CI、原生启动检查、Linux race 和完整变异测试。GitHub Actions 在 GitHub 仓库启用后运行；Gitee 镜像不执行这些工作流。本地产物不等于已公开发布。

## 验证记录

2026-10-24 的 ZIP 交付已验证解压启动、HTTPS 页面、中文/空格路径、端口占用、配置错误和后台进程清理；该记录对应旧版多文件交付。

2026-10-27 单 EXE：在空 PATH 环境中，只复制一个 EXE 到中文、空格和 `&` 目录，完成真实控制台首次配置及严格证书校验的 Local/Remote/ESP32 页面检查。启动目录和用户数据目录均未解压辅助 EXE、脚本或源码；许可证、版本、重启/改名后保持身份、端口占用及错误证书指纹拒绝检查通过。

后续直接编译验收：仅执行 `go build -o .../ShareSerial.exe .`，没有发布工具或二次处理；该文件在空 PATH 下通过相同启动检查，并确认不含附加 ZIP。编译时内嵌许可证和版本显示也正常，不要求运行目录存在任何源码、页面或许可证文件。

版本化交付验收：`0.1.0-beta.1` 文件名、CLI、Windows 文件属性中的 FileVersion/ProductVersion 一致，数值版本 `0.1.0.1` 且预发布标记生效；同一文件通过空 PATH 下的 HTTPS/首次配置/重启回归。资源生成器覆盖 Windows amd64/arm64，其他系统不链接 Windows 资源。

前述原生入口轮次的 Windows 两个架构及 Linux/macOS 四个目标均编译成功，六个产物的 SHA-256、格式和私有文件排除检查通过；完整 183/183 项变异检查通过，未将编译失败、超时或环境错误计为检出，对应源码/测试指纹为 `333409885d3d140154d6ba46d606ba949949201af780136041cc691602fc0d23`。后续编译资源轮次重新通过 Go 格式、vet、测试、131 项 Node 回归、工作流静态检查和直接编译程序的启动验收。

测试对证书信任和防火墙提示明确输入拒绝，未更改本机系统设置；真实客户端证书安装、UAC/防火墙、跨机器浏览器权限和实际串口仍待独立验收。其他平台的运行与 GitHub 实际工作流执行也需分别记录。Windows 本机无可用 C 编译器，race 由 Linux CI 验证，本轮不使用 WSL。
