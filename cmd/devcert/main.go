// devcert creates a unique private certificate. Never distribute its private key.
package main

import (
	"flag"
	"fmt"
	"os"
	"shareserial/localcert"
)

func main() {
	dir := flag.String("out", ".local/certs", "output directory (existing files are never overwritten)")
	hosts := flag.String("hosts", "localhost,127.0.0.1,::1", "comma-separated DNS names or IP addresses")
	days := flag.Int("days", 30, "certificate validity in days (1-365)")
	name := flag.String("name", "ShareSerial development", "certificate common name")
	flag.Parse()
	if err := generateCertificate(*dir, *hosts, *name, *days); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("Certificate written to %s. Each client must explicitly trust this private certificate.\n", *dir)
}

func generate(dir, hosts string) error {
	return generateCertificate(dir, hosts, "ShareSerial development", 30)
}

func generateCertificate(dir, hosts, name string, days int) error {
	return localcert.Generate(dir, hosts, name, days)
}
