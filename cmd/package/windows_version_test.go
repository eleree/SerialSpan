package main

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"testing"
)

func TestWindowsVersionResourceIsACompilerInputForBothArchitectures(t *testing.T) {
	for _, arch := range []string{"amd64", "arm64"} {
		data, err := windowsVersionObject("0.1.0-beta.1", arch)
		if err != nil {
			t.Fatal(err)
		}
		object, err := pe.NewFile(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		want := uint16(0x8664)
		if arch == "arm64" {
			want = 0xaa64
		}
		if object.Machine != want {
			t.Fatal("wrong object architecture")
		}
		section := object.Section(".rsrc")
		if section == nil {
			t.Fatal("missing standard resource section")
		}
		resource, err := section.Data()
		if err != nil {
			t.Fatal(err)
		}
		if len(section.Relocs) != 1 || section.Relocs[0].VirtualAddress != 72 {
			t.Fatal("resource RVA is not linked by Go")
		}
		if binary.LittleEndian.Uint32(resource[16:]) != 16 || binary.LittleEndian.Uint32(resource[64:]) != 0x409 {
			t.Fatal("missing RT_VERSION / language directory")
		}
		for _, text := range []string{"VS_VERSION_INFO", "FileVersion", "ProductVersion", "0.1.0-beta.1", "ShareSerial"} {
			if !bytes.Contains(resource, versionUTF16(text)) {
				t.Fatal("missing Windows file property", text)
			}
		}
		object.Close()
	}
	for _, version := range []string{"not-a-version", "1.2", "65536.1.0"} {
		if _, err := windowsVersionObject(version, "amd64"); err == nil {
			t.Fatal("invalid numeric Windows version accepted")
		}
	}
}
