package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"
)

// This is a COFF resource input consumed by the Go linker, not a PE patcher.
// It contains one RT_VERSION tree and its standard VERSIONINFO structure.
func prepareWindowsVersion(version, arch string) (string, error) {
	data, err := windowsVersionObject(version, arch)
	if err != nil {
		return "", err
	}
	name := "version_windows_" + arch + ".syso"
	file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", fmt.Errorf("create compiler version resource (existing files are never overwritten): %w", err)
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		os.Remove(name)
		return "", err
	}
	if err := file.Close(); err != nil {
		os.Remove(name)
		return "", err
	}
	return name, nil
}

func windowsVersionObject(version, arch string) ([]byte, error) {
	machine, relocation := uint16(0x8664), uint16(3) // AMD64 / ADDR32NB
	if arch == "arm64" {
		machine, relocation = 0xaa64, 2
	} else if arch != "amd64" {
		return nil, fmt.Errorf("unsupported Windows resource architecture %s", arch)
	}
	var numeric [4]uint32
	base, pre, _ := strings.Cut(version, "-")
	parts := strings.Split(base, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid version %s", version)
	}
	for i, part := range parts {
		value, err := strconv.ParseUint(part, 10, 16)
		if err != nil {
			return nil, err
		}
		numeric[i] = uint32(value)
	}
	if pre != "" {
		fields := strings.Split(pre, ".")
		if value, err := strconv.ParseUint(fields[len(fields)-1], 10, 16); err == nil {
			numeric[3] = uint32(value)
		}
	}
	flags := uint32(0)
	if pre != "" {
		flags = 2
	} // VS_FF_PRERELEASE
	fixed := new(bytes.Buffer)
	for _, value := range []uint32{0xfeef04bd, 0x10000, numeric[0]<<16 | numeric[1], numeric[2]<<16 | numeric[3], numeric[0]<<16 | numeric[1], numeric[2]<<16 | numeric[3], 0x3f, flags, 0x40004, 1, 0, 0, 0} {
		binary.Write(fixed, binary.LittleEndian, value)
	}
	var values []byte
	for _, pair := range [][2]string{
		{"CompanyName", "ShareSerial contributors"}, {"FileDescription", "ShareSerial LAN serial relay"},
		{"FileVersion", version}, {"InternalName", "ShareSerial"}, {"OriginalFilename", "ShareSerial.exe"},
		{"ProductName", "ShareSerial"}, {"ProductVersion", version},
	} {
		value := versionUTF16(pair[1])
		values = appendAligned(values, versionBlock(pair[0], value, uint16(len(value)/2), 1, nil))
	}
	stringsTable := versionBlock("040904B0", nil, 0, 1, values)
	stringsInfo := versionBlock("StringFileInfo", nil, 0, 1, stringsTable)
	translation := []byte{0x09, 0x04, 0xb0, 0x04} // en-US / Unicode
	variables := versionBlock("VarFileInfo", nil, 0, 1, versionBlock("Translation", translation, 4, 0, nil))
	info := versionBlock("VS_VERSION_INFO", fixed.Bytes(), 52, 0, appendAligned(stringsInfo, variables))
	resource := make([]byte, 88)
	put16 := func(offset int, value uint16) { binary.LittleEndian.PutUint16(resource[offset:], value) }
	put32 := func(offset int, value uint32) { binary.LittleEndian.PutUint32(resource[offset:], value) }
	put16(14, 1)
	put32(16, 16)
	put32(20, 0x80000000|24) // RT_VERSION
	put16(38, 1)
	put32(40, 1)
	put32(44, 0x80000000|48) // resource ID 1
	put16(62, 1)
	put32(64, 0x409)
	put32(68, 72) // language -> data entry
	put32(72, 88)
	put32(76, uint32(len(info)))
	resource = append(resource, info...)
	output := new(bytes.Buffer)
	// COFF header, one read-only initialized-data section, one relocation.
	write := func(value any) { binary.Write(output, binary.LittleEndian, value) }
	write(machine)
	write(uint16(1))
	write(uint32(0))
	write(uint32(60 + len(resource) + 10))
	write(uint32(1))
	write(uint16(0))
	write(uint16(0))
	output.Write([]byte{'.', 'r', 's', 'r', 'c', 0, 0, 0})
	for _, value := range []uint32{0, 0, uint32(len(resource)), 60, uint32(60 + len(resource)), 0} {
		write(value)
	}
	write(uint16(1))
	write(uint16(0))
	write(uint32(0x40000040))
	output.Write(resource)
	write(uint32(72))
	write(uint32(0))
	write(relocation)
	output.Write([]byte{'.', 'r', 's', 'r', 'c', 0, 0, 0})
	write(uint32(0))
	write(int16(1))
	write(uint16(0))
	write(uint8(3))
	write(uint8(0))
	write(uint32(4)) // empty COFF string table
	return output.Bytes(), nil
}

func versionUTF16(value string) []byte {
	buffer := new(bytes.Buffer)
	for _, unit := range append(utf16.Encode([]rune(value)), 0) {
		binary.Write(buffer, binary.LittleEndian, unit)
	}
	return buffer.Bytes()
}

func appendAligned(left, right []byte) []byte {
	for len(left)%4 != 0 {
		left = append(left, 0)
	}
	return append(left, right...)
}

func versionBlock(key string, value []byte, valueLength, kind uint16, children []byte) []byte {
	data := make([]byte, 6)
	binary.LittleEndian.PutUint16(data[2:], valueLength)
	binary.LittleEndian.PutUint16(data[4:], kind)
	data = appendAligned(append(data, versionUTF16(key)...), value)
	if len(children) > 0 {
		data = appendAligned(data, children)
	}
	binary.LittleEndian.PutUint16(data, uint16(len(data)))
	return data
}
