ShareSerial — 预览版 / Preview

文件名带完整产品版本。-version、启动窗口与 Windows 发布文件的文件/产品版本保持一致，预发布标记由构建时标准版本资源提供。

Windows 局域网：只需一个 EXE
1. 将 EXE 复制到目标 Windows，双击运行。不需要解压或安装开发环境。
2. 首次在窗口填写这台服务器的局域网 IPv4 地址/域名和端口。
3. 程序生成本机独有的非 CA HTTPS 证书；明确输入 YES 后才将它加入当前 Windows 用户信任。
   可按提示授权专用网络/本地子网的入站防火墙规则；此步需要管理员授权。
4. 程序显示并打开 Local/Remote 地址。保持窗口运行，Ctrl+C 或关闭窗口停止服务。
5. 配置及证书保存在 %LOCALAPPDATA%\ShareSerial，与 EXE 所在位置无关。
   将其中的 ShareSerial-LAN.cer 公开证书交给其他电脑；不要发送私钥或整个配置目录。
   其他 Local 电脑需核对指纹并导入当前用户的受信任根证书列表，才能使用 Web Serial。
6. 设备电脑打开 /local；远端打开 /remote 或 /remote/esp32，申请连接并等待 Local 批准。

一个 EXE 包含页面、服务、首次配置、证书生成和第三方许可证。
不会解压辅助 EXE、启动脚本或源码，不需要 Go、Node、Python、PowerShell、Docker 或 WSL。
信任和防火墙更改必须由用户明确确认；自动化 non-interactive 模式不修改这些系统设置。
证书有效期 365 天，仅用于受信私有局域网。共享码不是密码，不提供人员身份认证。
IP 改变或证书过期时，先停止服务，再运行：
  ShareSerial.exe -lan -configure
旧配置和证书保留；更新后各客户端需重新核对新证书。不再使用的信任可在 Windows 证书管理器中按指纹移除。
更换版本时停止旧程序，换用新 EXE；原配置和证书继续保留。若 EXE 路径改变，请重新核对防火墙规则。
程序日志直接显示在控制台；尚未提供系统服务安装或开机自启。

已有组织证书：修改配置文件的 certificate/privateKey 路径、publicHost，将 certificateMode 改为 provided。
provided 模式不会生成或导入证书；证书必须覆盖访问地址。相对路径以用户配置目录为基准。
维护和诊断命令（不需要开发工具）：
  ShareSerial.exe -version
  ShareSerial.exe -licenses
  ShareSerial.exe -lan -help
CLI 服务模式仍可显式传入 -addr / -cert / -key 等参数。

Linux / macOS
Extract the archive. Provide a trusted HTTPS certificate and private key, then run:
  SHARESERIAL_ADDR=0.0.0.0:12345 SHARESERIAL_CERT=/path/fullchain.pem SHARESERIAL_KEY=/path/key.pem ./start.sh
For an explicitly trusted private-LAN certificate, the included binary can generate a unique leaf certificate:
  ./tools/shareserial-cert -out certs -hosts localhost,127.0.0.1,192.168.1.100 -days 365 -name "ShareSerial LAN"
Replace the example IP; each client must explicitly trust the public certificate. No compiler or Node.js is needed.

Binaries are preview builds and not currently code-signed/notarized.
The Windows file is copied unchanged from go build. Notices are go:embed resources, and -version uses Go build metadata.
No data archive is appended after compilation. -licenses and -version work with a normal go build output.
Other platform archives include BUILD.json and licenses/. SHA256SUMS.txt is distributed beside the release files.
