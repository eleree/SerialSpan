package main

import (
	"crypto/tls"
	"crypto/x509"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDevelopmentCertificateAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	if err := generate(dir, "localhost,127.0.0.1,::1"); err != nil {
		t.Fatal(err)
	}
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	pair, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{"localhost", "127.0.0.1", "::1"} {
		if err := cert.VerifyHostname(host); err != nil {
			t.Fatal(err)
		}
	}
	original, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := generate(dir, "localhost"); err == nil {
		t.Fatal("overwrote existing key")
	}
	after, err := os.ReadFile(keyPath)
	if err != nil || string(original) != string(after) {
		t.Fatal("existing key changed")
	}
}

func TestLANCertificateValidityAndScope(t *testing.T) {
	dir := t.TempDir()
	if err := generateCertificate(dir, "localhost,192.168.1.23", "ShareSerial LAN", 365); err != nil {
		t.Fatal(err)
	}
	pair, err := tls.LoadX509KeyPair(filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if cert.IsCA || !cert.BasicConstraintsValid || cert.Subject.CommonName != "ShareSerial LAN" {
		t.Fatal("LAN helper must create a leaf server certificate, never a CA")
	}
	if err := cert.VerifyHostname("192.168.1.23"); err != nil {
		t.Fatal(err)
	}
	if err := cert.VerifyHostname("192.168.1.24"); err == nil {
		t.Fatal("certificate covers a different LAN server")
	}
	remaining := time.Until(cert.NotAfter)
	if remaining < 364*24*time.Hour || remaining > 366*24*time.Hour {
		t.Fatal("unexpected certificate validity")
	}
	for _, days := range []int{0, -1, 366} {
		if err := generateCertificate(t.TempDir(), "localhost", "ShareSerial LAN", days); err == nil {
			t.Fatal("unbounded certificate validity")
		}
	}
}
