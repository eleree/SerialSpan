package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"shareserial/localcert"
)

type desktopConfig struct {
	ListenAddress     string `json:"listenAddress"`
	PublicHost        string `json:"publicHost"`
	Port              int    `json:"port"`
	Certificate       string `json:"certificate"`
	PrivateKey        string `json:"privateKey"`
	CertificateMode   string `json:"certificateMode"`
	CertificateSHA256 string `json:"certificateSHA256,omitempty"`
	OpenBrowser       bool   `json:"openBrowser"`
}

type desktopOptions struct {
	dir, host                                                 string
	port                                                      int
	configure, noBrowser, noTrust, noFirewall, nonInteractive bool
}

func desktopEntry() (bool, error) {
	if handled, err := handleDistributionInfo(); handled {
		return true, err
	}
	if len(os.Args) > 1 && os.Args[1] != "-lan" && os.Args[1] != "-lan-firewall" {
		return false, nil
	}
	fmt.Println("ShareSerial v" + applicationVersion())
	options := desktopOptions{port: 12345}
	flags := flag.NewFlagSet("ShareSerial -lan", flag.ContinueOnError)
	flags.StringVar(&options.dir, "data-dir", "", "configuration directory (default: LOCALAPPDATA/ShareSerial)")
	flags.StringVar(&options.host, "host", "", "LAN IP or DNS name for first-run configuration")
	flags.IntVar(&options.port, "port", 12345, "LAN port")
	flags.BoolVar(&options.configure, "configure", false, "configure and exit")
	flags.BoolVar(&options.noBrowser, "no-browser", false, "do not open the browser")
	flags.BoolVar(&options.noTrust, "no-trust", false, "do not change certificate trust")
	flags.BoolVar(&options.noFirewall, "no-firewall", false, "do not configure the firewall")
	flags.BoolVar(&options.nonInteractive, "non-interactive", false, "do not prompt or modify system settings")
	if len(os.Args) > 1 {
		if err := flags.Parse(os.Args[2:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return true, nil
			}
			return true, err
		}
		if flags.NArg() != 0 {
			return true, errors.New("不支持的位置参数")
		}
	}
	if options.dir == "" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			return true, errors.New("无法定位 LOCALAPPDATA，请使用 -data-dir 指定配置目录")
		}
		options.dir = filepath.Join(base, "ShareSerial")
	}
	dir, err := filepath.Abs(options.dir)
	if err != nil {
		return true, err
	}
	options.dir = dir
	if len(os.Args) > 1 && os.Args[1] == "-lan-firewall" {
		config, err := loadDesktopConfig(dir)
		if err != nil {
			return true, err
		}
		return true, applyDesktopFirewall(dir, config.Port)
	}
	reader := bufio.NewReader(os.Stdin)
	_, err = os.Stat(filepath.Join(dir, "config.json"))
	created := options.configure || os.IsNotExist(err)
	if err != nil && !os.IsNotExist(err) {
		return true, err
	}
	if created {
		if err := configureDesktop(options, reader); err != nil {
			return true, err
		}
	}
	config, err := loadDesktopConfig(dir)
	if err != nil {
		return true, err
	}
	cert, key, err := validateDesktopCertificate(dir, config)
	if err != nil {
		return true, err
	}
	if config.CertificateMode == "private-lan" {
		if err := os.WriteFile(filepath.Join(dir, "ShareSerial-LAN.cer"), cert.Raw, 0644); err != nil {
			return true, err
		}
		fmt.Println("证书 SHA-256：", config.CertificateSHA256)
		if !options.noTrust && !options.nonInteractive {
			if _, err := cert.Verify(x509.VerifyOptions{DNSName: config.PublicHost}); err != nil {
				if desktopConfirm(reader, "将这张服务器证书加入当前 Windows 用户信任？输入 YES 确认") {
					if err := trustDesktopCertificate(cert); err != nil {
						return true, fmt.Errorf("证书信任失败：%w", err)
					}
				}
			}
		}
	}
	if created && !options.noFirewall && !options.nonInteractive && desktopConfirm(reader, "配置专用网络的局域网入站规则？需管理员授权，输入 YES 确认") {
		if err := elevateDesktopFirewall(dir, config.Port); err != nil {
			fmt.Fprintln(os.Stderr, "防火墙配置未完成：", err)
		}
	}
	fmt.Println("配置目录：", dir)
	if config.CertificateMode == "private-lan" {
		fmt.Println("公开证书：", filepath.Join(dir, "ShareSerial-LAN.cer"))
	}
	if options.configure {
		return true, nil
	}
	// Detect conflicting IPv4 listeners before net/http's dual-stack bind.
	probe, err := net.Listen("tcp4", config.ListenAddress)
	if err != nil {
		return true, fmt.Errorf("监听端口不可用：%w", err)
	}
	_ = probe.Close()
	baseURL := "https://" + net.JoinHostPort(config.PublicHost, strconv.Itoa(config.Port))
	fmt.Println("Local: ", baseURL+"/local")
	fmt.Println("Remote:", baseURL+"/remote")
	fmt.Println("ESP32: ", baseURL+"/remote/esp32")
	fmt.Println("保持本窗口运行；Ctrl+C 或关闭窗口停止服务。")
	if !options.noBrowser && config.OpenBrowser {
		go openDesktopWhenReady(config, cert, baseURL+"/local")
	}
	// The same process runs the original relay; there is no extracted backend.
	os.Args = []string{os.Args[0], "-addr", config.ListenAddress, "-cert", desktopPath(dir, config.Certificate), "-key", key}
	return false, nil
}

func desktopConfirm(reader *bufio.Reader, message string) bool {
	fmt.Print(message + "（其他输入跳过）：")
	answer, _ := reader.ReadString('\n')
	return strings.TrimSpace(answer) == "YES"
}

func configureDesktop(options desktopOptions, reader *bufio.Reader) error {
	if options.host == "" {
		if options.nonInteractive {
			return errors.New("首次配置需要 -host")
		}
		fmt.Println("输入这台服务器的局域网 IPv4 地址或域名。可用网卡：")
		interfaces, _ := net.Interfaces()
		for _, iface := range interfaces {
			if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
				continue
			}
			addresses, _ := iface.Addrs()
			for _, address := range addresses {
				ip, _, _ := net.ParseCIDR(address.String())
				if ip.To4() != nil && !ip.IsLinkLocalUnicast() {
					fmt.Printf("  %s: %s\n", iface.Name, ip)
				}
			}
		}
		fmt.Print("局域网 IPv4 / 域名：")
		answer, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		options.host = strings.TrimSpace(answer)
		fmt.Print("端口（回车使用 12345）：")
		answer, err = reader.ReadString('\n')
		if err != nil {
			return err
		}
		if strings.TrimSpace(answer) != "" {
			options.port, err = strconv.Atoi(strings.TrimSpace(answer))
			if err != nil {
				return errors.New("无效端口")
			}
		}
	}
	config := desktopConfig{ListenAddress: net.JoinHostPort("0.0.0.0", strconv.Itoa(options.port)), PublicHost: options.host, Port: options.port, CertificateMode: "private-lan", OpenBrowser: true}
	if err := config.validate(); err != nil {
		return err
	}
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	certDir := "certs-" + hex.EncodeToString(random)
	if err := localcert.Generate(filepath.Join(options.dir, certDir), "localhost,127.0.0.1,"+config.PublicHost, "ShareSerial LAN", 365); err != nil {
		return err
	}
	config.Certificate = filepath.ToSlash(filepath.Join(certDir, "cert.pem"))
	config.PrivateKey = filepath.ToSlash(filepath.Join(certDir, "key.pem"))
	cert, err := readDesktopCertificate(desktopPath(options.dir, config.Certificate))
	if err != nil {
		return err
	}
	hash := sha256.Sum256(cert.Raw)
	config.CertificateSHA256 = hex.EncodeToString(hash[:])
	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	configFile := filepath.Join(options.dir, "config.json")
	if previous, err := os.ReadFile(configFile); err == nil {
		if err := os.WriteFile(filepath.Join(options.dir, "config.previous.json"), previous, 0600); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	temp, err := os.CreateTemp(options.dir, ".config-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err := temp.Chmod(0600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(append(encoded, '\n')); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), configFile)
}

func (config desktopConfig) validate() error {
	ip, port, err := net.SplitHostPort(config.ListenAddress)
	if err != nil || net.ParseIP(ip).To4() == nil || port != strconv.Itoa(config.Port) || config.Port < 1 || config.Port > 65535 {
		return errors.New("监听地址必须为 IPv4，port 与监听端口必须一致（1-65535）")
	}
	host := config.PublicHost
	if len(host) == 0 || len(host) > 253 {
		return errors.New("缺少有效访问地址")
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.To4() == nil || ip.IsUnspecified() || ip.IsMulticast() {
			return errors.New("请输入客户端可访问的 IPv4 地址")
		}
	} else {
		for _, label := range strings.Split(host, ".") {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return errors.New("无效域名")
			}
			for _, char := range label {
				if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-') {
					return errors.New("访问地址不能包含协议、路径或端口")
				}
			}
		}
	}
	if config.CertificateMode != "private-lan" && config.CertificateMode != "provided" {
		return errors.New("无效证书模式")
	}
	return nil
}

func loadDesktopConfig(dir string) (desktopConfig, error) {
	var config desktopConfig
	file, err := os.Open(filepath.Join(dir, "config.json"))
	if err != nil {
		return config, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return config, err
	}
	if info.Size() > 65536 {
		return config, errors.New("配置文件超过 64 KiB")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 65537))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, fmt.Errorf("配置无效：%w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return config, errors.New("配置必须只有一个 JSON 对象")
	}
	if config.Certificate == "" || config.PrivateKey == "" {
		return config, errors.New("缺少证书或私钥路径")
	}
	return config, config.validate()
}

func desktopPath(dir, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(dir, path)
}

func readDesktopCertificate(path string) (*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("证书必须为 PEM 格式")
	}
	return x509.ParseCertificate(block.Bytes)
}

func validateDesktopCertificate(dir string, config desktopConfig) (*x509.Certificate, string, error) {
	key := desktopPath(dir, config.PrivateKey)
	certPath := desktopPath(dir, config.Certificate)
	if _, err := tls.LoadX509KeyPair(certPath, key); err != nil {
		return nil, "", fmt.Errorf("证书与私钥无效：%w", err)
	}
	cert, err := readDesktopCertificate(certPath)
	if err != nil {
		return nil, "", err
	}
	if now := time.Now(); now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) {
		return nil, "", errors.New("证书已过期或尚未生效，请用 -lan -configure 重新配置")
	}
	if err := cert.VerifyHostname(config.PublicHost); err != nil {
		return nil, "", fmt.Errorf("证书不覆盖访问地址：%w", err)
	}
	if config.CertificateMode == "private-lan" {
		hash := sha256.Sum256(cert.Raw)
		if hex.EncodeToString(hash[:]) != config.CertificateSHA256 || cert.IsCA || !cert.BasicConstraintsValid || cert.Subject.CommonName != "ShareSerial LAN" || !bytes.Equal(cert.RawSubject, cert.RawIssuer) || cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature) != nil {
			return nil, "", errors.New("局域网证书与本机配置不匹配，拒绝导入信任")
		}
	}
	return cert, key, nil
}

func trustDesktopCertificate(cert *x509.Certificate) error {
	name, err := windows.UTF16PtrFromString("ROOT")
	if err != nil {
		return err
	}
	store, err := windows.CertOpenStore(windows.CERT_STORE_PROV_SYSTEM_W, 0, 0, windows.CERT_SYSTEM_STORE_CURRENT_USER, uintptr(unsafe.Pointer(name)))
	if err != nil {
		return err
	}
	defer windows.CertCloseStore(store, 0)
	context, err := windows.CertCreateCertificateContext(windows.X509_ASN_ENCODING, &cert.Raw[0], uint32(len(cert.Raw)))
	if err != nil {
		return err
	}
	defer windows.CertFreeCertificateContext(context)
	return windows.CertAddCertificateContextToStore(store, context, windows.CERT_STORE_ADD_USE_EXISTING, nil)
}

func applyDesktopFirewall(dir string, port int) error {
	if port < 1 || port > 65535 {
		return errors.New("无效端口")
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		return errors.New("配置防火墙需要管理员授权")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	hash := sha256.Sum256([]byte(strings.ToLower(dir)))
	name := fmt.Sprintf("ShareSerial-LAN-%x-%d", hash[:6], port)
	command := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "netsh.exe"), "advfirewall", "firewall", "add", "rule", "name="+name, "dir=in", "action=allow", "protocol=TCP", "localport="+strconv.Itoa(port), "program="+self, "profile=private", "remoteip=localsubnet", "enable=yes")
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, output)
	}
	return nil
}

func elevateDesktopFirewall(dir string, port int) error {
	if windows.GetCurrentProcessToken().IsElevated() {
		return applyDesktopFirewall(dir, port)
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	args := "-lan-firewall -data-dir " + syscall.EscapeArg(dir)
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(self)
	parameters, _ := windows.UTF16PtrFromString(args)
	info := struct {
		Size, Mask                        uint32
		Window                            windows.Handle
		Verb, File, Parameters, Directory *uint16
		Show                              int32
		Instance                          windows.Handle
		IDList                            uintptr
		Class                             *uint16
		Key                               windows.Handle
		HotKey                            uint32
		Icon, Process                     windows.Handle
	}{Mask: 0x40 | 0x100, Verb: verb, File: file, Parameters: parameters}
	info.Size = uint32(unsafe.Sizeof(info))
	result, _, callErr := windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW").Call(uintptr(unsafe.Pointer(&info)))
	if result == 0 {
		return callErr
	}
	if info.Process == 0 {
		return errors.New("未能获取防火墙配置进程")
	}
	defer windows.CloseHandle(info.Process)
	if _, err := windows.WaitForSingleObject(info.Process, windows.INFINITE); err != nil {
		return err
	}
	var code uint32
	if err := windows.GetExitCodeProcess(info.Process, &code); err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("防火墙配置退出代码 %d", code)
	}
	return nil
}

func openDesktopWhenReady(config desktopConfig, cert *x509.Certificate, url string) {
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: config.PublicHost, MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second}
	for attempt := 0; attempt < 60; attempt++ {
		response, err := client.Get("https://127.0.0.1:" + strconv.Itoa(config.Port) + "/api/network-sample")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusNoContent {
				verb, _ := windows.UTF16PtrFromString("open")
				target, _ := windows.UTF16PtrFromString(url)
				if err := windows.ShellExecute(0, verb, target, nil, nil, windows.SW_SHOWNORMAL); err != nil {
					fmt.Fprintln(os.Stderr, "请手动打开：", url)
				}
				return
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	fmt.Fprintln(os.Stderr, "未能确认 HTTPS 就绪，请核对证书和访问地址：", url)
}
