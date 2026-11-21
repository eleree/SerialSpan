package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDesktopConfigurationPreservesKeysAndRejectsStaleIdentity(t *testing.T) {
	dir := t.TempDir()
	options := desktopOptions{dir: dir, host: "127.0.0.1", port: 18443, nonInteractive: true}
	if err := configureDesktop(options, bufio.NewReader(strings.NewReader(""))); err != nil {
		t.Fatal(err)
	}
	config, err := loadDesktopConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	cert, key, err := validateDesktopCertificate(dir, config)
	if err != nil {
		t.Fatal(err)
	}
	if cert.IsCA || cert.Subject.CommonName != "ShareSerial LAN" {
		t.Fatal("not a private LAN leaf certificate")
	}
	original, err := os.ReadFile(key)
	if err != nil {
		t.Fatal(err)
	}
	other := config
	other.PublicHost = "192.168.1.99"
	if _, _, err := validateDesktopCertificate(dir, other); err == nil {
		t.Fatal("wrong host accepted")
	}
	other = config
	other.CertificateSHA256 = strings.Repeat("0", 64)
	if _, _, err := validateDesktopCertificate(dir, other); err == nil {
		t.Fatal("stale certificate identity accepted")
	}
	if err := configureDesktop(options, bufio.NewReader(strings.NewReader(""))); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(key)
	if err != nil || string(after) != string(original) {
		t.Fatal("existing private key was overwritten")
	}
	updated, err := loadDesktopConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if updated.CertificateSHA256 == config.CertificateSHA256 {
		t.Fatal("reconfiguration reused a certificate")
	}
	if _, err := os.Stat(filepath.Join(dir, "config.previous.json")); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopConfigRejectsTyposAndUnsafeNetworkSettings(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "config.json")
	config := desktopConfig{ListenAddress: "0.0.0.0:12345", PublicHost: "localhost", Port: 12345, Certificate: "cert.pem", PrivateKey: "key.pem", CertificateMode: "provided"}
	for _, input := range []string{`{"listenAdress":"0.0.0.0:12345"}`, strings.Repeat(" ", 65537), `{} {}`} {
		if err := os.WriteFile(file, []byte(input), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadDesktopConfig(dir); err == nil {
			t.Fatal("invalid JSON/config accepted")
		}
	}
	for _, host := range []string{"", "0.0.0.0", "224.0.0.1", "::1", "https://localhost", "localhost:12345", "a/b", "a;start", "-host"} {
		modified := config
		modified.PublicHost = host
		if err := modified.validate(); err == nil {
			t.Fatalf("accepted host %q", host)
		}
	}
	for _, port := range []int{0, -1, 65536, 12346} {
		modified := config
		modified.Port = port
		if err := modified.validate(); err == nil {
			t.Fatal("invalid/mismatched port accepted")
		}
	}
	data, _ := json.Marshal(config)
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadDesktopConfig(dir); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopSystemChangesRequireExplicitConfirmation(t *testing.T) {
	for input, want := range map[string]bool{"YES\n": true, "yes\n": false, "\n": false, "NO\n": false, "": false} {
		if got := desktopConfirm(bufio.NewReader(strings.NewReader(input)), "test"); got != want {
			t.Fatalf("input %q: got %v", input, got)
		}
	}
}
