package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseInputAndArchiveConfinement(t *testing.T) {
	for _, value := range []string{"windows/386", "windows/amd64,windows/amd64", "../linux/amd64", ""} {
		if _, err := selectTargets(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	targets, err := selectTargets("all")
	if err != nil || len(targets) != 6 {
		t.Fatal("missing target", err)
	}
	for _, version := range []string{"../1.0.0", "1.2.3/secret", "v1.0.0", "1.0.0;cmd", "1.0.0-"} {
		if versionPattern.MatchString(version) {
			t.Fatalf("unsafe version %q", version)
		}
	}
	for _, version := range []string{"0.1.0", "0.1.0-beta.1", "0.1.0-preview.20261024"} {
		if !versionPattern.MatchString(version) {
			t.Fatalf("rejected version %q", version)
		}
	}
	for _, name := range []string{"../key.pem", "/absolute", `tools\..\key`, ""} {
		if err := writeArchive(filepath.Join(t.TempDir(), "bad.zip"), "ShareSerial", []entry{{name, []byte("secret"), 0600}}, true); err == nil {
			t.Fatalf("unsafe archive member %q", name)
		}
	}
	if err := writeArchive(filepath.Join(t.TempDir(), "duplicate.zip"), "ShareSerial", []entry{{"a", nil, 0644}, {"a", nil, 0644}}, true); err == nil {
		t.Fatal("duplicate archive member")
	}
}

func TestArchiveBytesModesAndNoOverwrite(t *testing.T) {
	files := []entry{{"start.sh", []byte("#!/bin/sh\n"), 0755}, {"README.txt", []byte("hello\n"), 0644}}
	for _, windows := range []bool{true, false} {
		path := filepath.Join(t.TempDir(), "package")
		if err := writeArchive(path, "ShareSerial", files, windows); err != nil {
			t.Fatal(err)
		}
		if err := writeArchive(path, "ShareSerial", files, windows); err == nil {
			t.Fatal("overwrote a release archive")
		}
		members := map[string][]byte{}
		if windows {
			archive, err := zip.OpenReader(path)
			if err != nil {
				t.Fatal(err)
			}
			defer archive.Close()
			for _, file := range archive.File {
				member, err := file.Open()
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(member)
				member.Close()
				if err != nil {
					t.Fatal(err)
				}
				members[file.Name] = data
				if file.Name == "ShareSerial/start.sh" && file.Mode().Perm() != 0755 {
					t.Fatal("lost executable mode")
				}
			}
		} else {
			file, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			compressed, err := gzip.NewReader(file)
			if err != nil {
				t.Fatal(err)
			}
			defer compressed.Close()
			reader := tar.NewReader(compressed)
			for {
				header, err := reader.Next()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(reader)
				if err != nil {
					t.Fatal(err)
				}
				members[header.Name] = data
				if header.Name == "ShareSerial/start.sh" && header.Mode != 0755 {
					t.Fatal("lost executable mode")
				}
			}
		}
		if len(members) != 2 || string(members["ShareSerial/start.sh"]) != "#!/bin/sh\n" || string(members["ShareSerial/README.txt"]) != "hello\n" {
			t.Fatal("archive contents changed")
		}
	}
}

func TestDistributionUsesOnlyPublicAssets(t *testing.T) {
	// distributionFiles intentionally reads an allowlist, not a directory walk.
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(filepath.Join("..", "..")); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(previous)
	files, err := distributionFiles("windows")
	if err != nil {
		t.Fatal(err)
	}
	var readme bool
	for _, file := range files {
		if strings.Contains(file.name, ".local") || strings.HasSuffix(file.name, ".pem") || strings.HasSuffix(file.name, ".key") || strings.HasSuffix(file.name, ".log") {
			t.Fatal("private runtime file in package", file.name)
		}
		if file.name == "README.txt" {
			readme = true
		}
		if strings.HasSuffix(file.name, ".cmd") || strings.HasSuffix(file.name, ".ps1") {
			t.Fatal("obsolete Windows runtime script in distribution")
		}
	}
	if !readme {
		t.Fatal("distribution has no user instructions")
	}
}

func TestStandaloneIsTheUnmodifiedGoBuildOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ShareSerial.exe")
	files := []entry{{"shareserial.exe", []byte("MZ-native-program"), 0755}, {"BUILD.json", []byte(`{"version":"0.1.0"}`), 0644},
		{"licenses/go/LICENSE-Go.txt", []byte("public license"), 0644}, {"tools/cert.exe", []byte("helper"), 0755},
		{"tools/manage.ps1", []byte("script"), 0644}, {"private.key", []byte("secret"), 0600}}
	if err := writeStandalone(path, files); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "MZ-native-program" {
		t.Fatal("Go executable was repackaged or modified")
	}
	if archive, err := zip.OpenReader(path); err == nil {
		archive.Close()
		t.Fatal("unexpected appended ZIP")
	}
}

func TestEmbeddedNoticesAcceptWindowsLineEndingsButRequireFullLicense(t *testing.T) {
	files := []entry{{"licenses/example/LICENSE", []byte("Copyright example\nPermission granted\n"), 0644}}
	notice := "--- licenses/example/LICENSE ---\nCopyright example\nPermission granted\n"
	for _, text := range []string{notice, strings.ReplaceAll(notice, "\n", "\r\n")} {
		if err := checkDistributionNotices([]byte(text), files); err != nil {
			t.Fatal(err)
		}
	}
	if err := checkDistributionNotices([]byte(strings.ReplaceAll(notice, "Permission granted\n", "")), files); err == nil {
		t.Fatal("accepted an incomplete license")
	}
}
