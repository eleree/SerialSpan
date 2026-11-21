# 贡献指南 / Contributing

欢迎提交可以复现的问题、文档修正和小范围 Pull Request。贡献代码采用仓库的 MIT 许可证；新增第三方代码须保留其许可和来源。

## 开发环境

- Go 1.25 或更新版本，建议使用所在版本线的最新补丁：[官方下载](https://go.dev/dl/)。
- Node.js 24，仅用于无依赖的 JavaScript 测试；不需要 npm install。
- 共享设备的浏览器必须支持 Web Serial，使用可信 HTTPS。

```sh
git clone https://github.com/eleree/SerialSpan.git
cd SerialSpan
go mod download
go run ./cmd/devcert
go run .
```

开发证书生成器拒绝覆盖现有文件。需要新证书时，指定新的 -out 目录并用服务器的 -cert/-key 参数选择它们。

## 验证

```sh
gofmt -w main.go main_test.go handler websocket cmd
go vet ./...
go test ./...
go test -race ./...
node --check static/js/serial-data.js
node --check static/js/local.js
node --check static/js/remote.js
node --test tests/serial-data.test.cjs tests/browser.test.cjs tests/access.test.cjs
node --test tests/mutation-runner.test.cjs
node scripts/mutation-test.cjs
go build -o .local/shareserial .
```

Windows 的 race 检查需要可用的 C 编译器，也可在 WSL/Linux 上运行。普通测试不依赖串口硬件。

定向变异测试的范围、隔离方式、判定与报告见 [MUTATION_TESTING.md](docs/MUTATION_TESTING.md)。它修改临时副本，基线失败、存活变异、无效变异、超时或环境错误都会使门禁失败。

GitHub Actions 执行 Linux、Windows、macOS 的构建与测试，并在 Linux 运行 race 检查。Gitee 保留为镜像，不执行 GitHub workflow；本地命令是同一验证基线。

## 报告问题与提交变更

请说明操作系统、浏览器、Go 版本、设备类型、Local/Remote 操作顺序、期望结果和实际结果。日志只保留必要内容，去掉连接 ID、私密串口数据和证书。

PR 应描述具体问题、最终行为、验证结果、协议兼容性影响。涉及协议时同步修改 PROTOCOL.md、两个 README 和 CHANGELOG.md。安全问题按 SECURITY.md 处理。

## 发布检查

- 交付使用预编译包，维护者构建与 GitHub 草稿发布流程见 [发布包部署](docs/DEPLOYMENT.md)。用户运行不需要开发环境。
- 版本以 `VERSION` 为准；版本更新同时维护 CHANGELOG，Git 标签使用 `v<版本>`。Windows 交付必须包含构建前生成的版本属性，不能只重命名文件或在编译后补丁修改。
- 更新依赖后运行 `go run ./cmd/package -sync-notices` 并提交 `THIRD_PARTY_NOTICES.txt`；它是普通 `go build` 所需的编译时许可资源，不是运行时文件。
- 自动化检查通过，并记录实际浏览器/硬件联调结果。
- 核对中英文文档、协议、CHANGELOG、已知限制和版本号。
- 校验 git diff --check，确认变更中没有密钥、证书和产物。
- 确认许可证、依赖许可证和新引入素材的来源。
- 首次正式发布前按 ROADMAP.md 完成未完成事项；不得把开发基线当作已通过公网安全验证的版本。
- 不上传 .local/legacy，也不把旧历史中的开发私钥用于部署。

English: use Go 1.25+ and Node.js 24, run all checks above, keep changes reviewable, update both READMEs and the protocol for behavior changes, and report hardware testing separately from simulated tests.
