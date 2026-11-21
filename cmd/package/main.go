// package builds allowlisted, SDK-free distribution archives. It never copies
// the working directory, deployment credentials or generated certificates.
package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

//go:embed assets/*
var templates embed.FS

var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$`)

var supported = []string{"windows/amd64", "windows/arm64", "linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64"}

type entry struct {
	name string
	data []byte
	mode int64
}

func main() {
	version := flag.String("version", "", "release version (defaults to VERSION; must match it)")
	targets := flag.String("targets", "all", "all, native, or comma-separated GOOS/GOARCH pairs")
	output := flag.String("out", "dist", "output directory; version subdirectory must not already exist")
	syncNotices := flag.Bool("sync-notices", false, "refresh compile-time third-party notices after dependency updates")
	flag.Parse()
	if *syncNotices {
		if err := syncDistributionNotices(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := buildRelease(*version, *targets, *output); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func selectTargets(value string) ([]string, error) {
	if value == "all" {
		return append([]string(nil), supported...), nil
	}
	if value == "native" {
		value = runtime.GOOS + "/" + runtime.GOARCH
	}
	seen := map[string]bool{}
	var result []string
	for _, target := range strings.Split(value, ",") {
		found := false
		for _, allowed := range supported {
			if target == allowed {
				found = true
			}
		}
		if !found || seen[target] {
			return nil, fmt.Errorf("unsupported or repeated release target %q", target)
		}
		seen[target] = true
		result = append(result, target)
	}
	return result, nil
}

func buildRelease(version, selection, output string) error {
	source, err := os.ReadFile("VERSION")
	if err != nil {
		return err
	}
	declared := strings.TrimSpace(string(source))
	if version == "" {
		version = declared
	}
	if !versionPattern.MatchString(version) {
		return fmt.Errorf("-version must be a numeric release version, optionally with a prerelease suffix")
	}
	if version != declared {
		return fmt.Errorf("release version %s differs from VERSION %s; update VERSION first", version, declared)
	}
	targets, err := selectTargets(selection)
	if err != nil {
		return err
	}
	if data, err := os.ReadFile("go.mod"); err != nil || !strings.HasPrefix(string(data), "module shareserial\n") && !strings.HasPrefix(string(data), "module shareserial\r\n") {
		return fmt.Errorf("run the packager from the ShareSerial repository root")
	}
	destination, err := filepath.Abs(filepath.Join(output, version))
	if err != nil {
		return err
	}
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("release output already exists: %s (never overwritten)", destination)
	} else if !os.IsNotExist(err) {
		return err
	}
	// The temporary directory is a direct child of the selected output parent.
	// Nothing from the repository is recursively copied or removed.
	parent := filepath.Dir(destination)
	if err := os.MkdirAll(parent, 0755); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".shareserial-package-")
	if err != nil {
		return err
	}
	defer func() {
		if filepath.Dir(stage) == parent && strings.HasPrefix(filepath.Base(stage), ".shareserial-package-") {
			_ = os.RemoveAll(stage)
		}
	}()
	commit := "unknown"
	if data, err := exec.Command("git", "rev-parse", "HEAD").Output(); err == nil {
		commit = strings.TrimSpace(string(data))
	}
	dirty := true
	if data, err := exec.Command("git", "status", "--porcelain").Output(); err == nil {
		dirty = len(data) != 0
	}
	var sums []string
	for _, target := range targets {
		fmt.Println("Building", target)
		parts := strings.Split(target, "/")
		env := buildEnv(parts[0], parts[1])
		ext := ""
		if parts[0] == "windows" {
			ext = ".exe"
		}
		var files []entry
		for _, binary := range []struct{ output, source string }{{"shareserial", "."}, {"tools/shareserial-cert", "./cmd/devcert"}} {
			if parts[0] == "windows" && binary.source != "." {
				continue
			}
			name := binary.output + ext
			path := filepath.Join(stage, "build", parts[0], parts[1], filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
				return err
			}
			linkFlags := "-s -w"
			if binary.source == "." {
				linkFlags += " -X main.buildVersion=" + version + " -X main.buildCommit=" + commit + " -X main.buildDirty=" + fmt.Sprint(dirty)
			}
			command := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-buildvcs=false", "-trimpath", "-ldflags="+linkFlags, "-o", path, binary.source)
			command.Env, command.Stdout, command.Stderr = env, os.Stdout, os.Stderr
			var resourceFile string
			if parts[0] == "windows" && binary.source == "." {
				resourceFile, err = prepareWindowsVersion(version, parts[1])
				if err != nil {
					return err
				}
			}
			buildErr := command.Run()
			if resourceFile != "" {
				if err := os.Remove(resourceFile); err != nil {
					return err
				}
			}
			if buildErr != nil {
				return fmt.Errorf("build %s for %s: %w", name, target, buildErr)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			files = append(files, entry{name, data, 0755})
		}
		assets, err := distributionFiles(parts[0])
		if err != nil {
			return err
		}
		files = append(files, assets...)
		licenses, err := dependencyLicenses(env)
		if err != nil {
			return err
		}
		files = append(files, licenses...)
		if err := validateDistributionNotices(files); err != nil {
			return err
		}
		metadata, _ := json.MarshalIndent(map[string]any{"version": version, "target": target, "go": runtime.Version(), "commit": commit, "workingTreeModified": dirty}, "", "  ")
		files = append(files, entry{"BUILD.json", append(metadata, '\n'), 0644})
		name := "ShareSerial-v" + version + "-" + parts[0] + "-" + parts[1]
		archive := name + ".tar.gz"
		if parts[0] == "windows" {
			archive = name + ".exe"
			if err := writeStandalone(filepath.Join(stage, archive), files); err != nil {
				return err
			}
		} else {
			if err := writeArchive(filepath.Join(stage, archive), name, files, false); err != nil {
				return err
			}
		}
		data, err := os.ReadFile(filepath.Join(stage, archive))
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		sums = append(sums, hex.EncodeToString(sum[:])+"  "+archive)
	}
	if err := os.RemoveAll(filepath.Join(stage, "build")); err != nil {
		return err
	}
	sort.Strings(sums)
	if err := os.WriteFile(filepath.Join(stage, "SHA256SUMS.txt"), []byte(strings.Join(sums, "\n")+"\n"), 0644); err != nil {
		return err
	}
	if err := os.Rename(stage, destination); err != nil {
		return err
	}
	fmt.Println("Release packages:", destination)
	return nil
}

func writeStandalone(path string, files []entry) error {
	for _, file := range files {
		if file.name == "shareserial.exe" {
			if len(file.data) < 2 || string(file.data[:2]) != "MZ" {
				return fmt.Errorf("Windows executable is invalid")
			}
			output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
			if err != nil {
				return err
			}
			if _, err := output.Write(file.data); err != nil {
				output.Close()
				return err
			}
			return output.Close()
		}
	}
	return fmt.Errorf("Windows executable is missing")
}

func syncDistributionNotices() error {
	unique := map[string]entry{}
	assets, err := distributionFiles("windows")
	if err != nil {
		return err
	}
	for _, file := range assets {
		if strings.HasPrefix(file.name, "licenses/") {
			unique[file.name] = file
		}
	}
	for _, target := range supported {
		parts := strings.Split(target, "/")
		files, err := dependencyLicenses(buildEnv(parts[0], parts[1]))
		if err != nil {
			return err
		}
		for _, file := range files {
			unique[file.name] = file
		}
	}
	var names []string
	for name := range unique {
		names = append(names, name)
	}
	sort.Strings(names)
	var notice strings.Builder
	notice.WriteString("ShareSerial third-party notices.\nGenerated from the pinned dependencies for all supported targets.\nMaintainers: refresh with go run ./cmd/package -sync-notices after dependency changes.\n")
	for _, name := range names {
		notice.WriteString("\n--- " + name + " ---\n")
		notice.Write(unique[name].data)
		notice.WriteByte('\n')
	}
	return os.WriteFile("THIRD_PARTY_NOTICES.txt", []byte(strings.TrimRight(notice.String(), "\r\n")+"\n"), 0644)
}

func validateDistributionNotices(files []entry) error {
	notice, err := os.ReadFile("THIRD_PARTY_NOTICES.txt")
	if err != nil {
		return err
	}
	return checkDistributionNotices(notice, files)
}

func checkDistributionNotices(notice []byte, files []entry) error {
	// Git may check text resources out with CRLF on Windows.
	text := strings.ReplaceAll(string(notice), "\r\n", "\n")
	for _, file := range files {
		if !strings.HasPrefix(file.name, "licenses/") {
			continue
		}
		body := strings.ReplaceAll(string(file.data), "\r\n", "\n")
		if !strings.Contains(text, "--- "+file.name+" ---\n"+body) {
			return fmt.Errorf("compile-time notice is missing or outdated for %s; refresh with go run ./cmd/package -sync-notices", file.name)
		}
	}
	return nil
}

func buildEnv(goos, goarch string) []string {
	overrides := map[string]string{"GOOS": goos, "GOARCH": goarch, "CGO_ENABLED": "0", "GOFLAGS": "", "GOWORK": "off"}
	var env []string
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if _, replaced := overrides[strings.ToUpper(key)]; !replaced {
			env = append(env, value)
		}
	}
	for key, value := range overrides {
		env = append(env, key+"="+value)
	}
	return env
}

func distributionFiles(goos string) ([]entry, error) {
	var files []entry
	for _, name := range []string{"LICENSE", "docs/THIRD_PARTY_NOTICES.md", "static/vendor/esptool-js-0.7.0.LICENSE.txt", "static/vendor/pako-2.1.0.LICENSE.txt", "static/vendor/atob-lite-2.0.0.LICENSE.txt"} {
		data, err := os.ReadFile(name)
		if err != nil {
			return nil, err
		}
		files = append(files, entry{"licenses/" + filepath.Base(name), data, 0644})
	}
	readme, err := templates.ReadFile("assets/README.txt")
	if err != nil {
		return nil, err
	}
	files = append(files, entry{"README.txt", readme, 0644})
	if goos != "windows" {
		data, err := templates.ReadFile("assets/start.sh")
		if err != nil {
			return nil, err
		}
		files = append(files, entry{"start.sh", data, 0755})
	}
	return files, nil
}

func dependencyLicenses(env []string) ([]entry, error) {
	command := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "list", "-deps", "-json", ".")
	command.Env, command.Stderr = env, os.Stderr
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(output)))
	modules := map[string]string{}
	for {
		var item struct {
			Module *struct{ Path, Version, Dir string }
		}
		if err := decoder.Decode(&item); err == io.EOF {
			break
		} else if err != nil {
			return nil, err
		}
		if item.Module != nil && item.Module.Path != "shareserial" {
			modules[item.Module.Path+"@"+item.Module.Version] = item.Module.Dir
		}
	}
	var files []entry
	for module, dir := range modules {
		children, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		found := false
		for _, child := range children {
			name := strings.ToUpper(child.Name())
			if !child.Type().IsRegular() || !(strings.HasPrefix(name, "LICENSE") || strings.HasPrefix(name, "COPYING") || name == "NOTICE" || name == "NOTICE.TXT") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, child.Name()))
			if err != nil {
				return nil, err
			}
			files = append(files, entry{"licenses/go/" + module + "/" + child.Name(), data, 0644})
			found = true
		}
		if !found {
			return nil, fmt.Errorf("dependency has no root license file: %s", module)
		}
	}
	data, err := os.ReadFile(filepath.Join(runtime.GOROOT(), "LICENSE"))
	if err != nil {
		return nil, err
	}
	return append(files, entry{"licenses/go/LICENSE-Go.txt", data, 0644}), nil
}

func writeArchive(path, root string, files []entry, windows bool) (err error) {
	sort.Slice(files, func(i, j int) bool { return files[i].name < files[j].name })
	seen := map[string]bool{}
	for _, file := range files {
		if file.name == "" || strings.Contains(file.name, "\\") || strings.Contains(file.name, "..") || strings.HasPrefix(file.name, "/") || seen[file.name] {
			return fmt.Errorf("unsafe or repeated archive member: %q", file.name)
		}
		seen[file.name] = true
	}
	output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := output.Close(); err == nil {
			err = closeErr
		}
	}()
	if windows {
		writer := zip.NewWriter(output)
		for _, file := range files {
			header := &zip.FileHeader{Name: root + "/" + file.name, Method: zip.Deflate}
			header.SetMode(os.FileMode(file.mode))
			header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
			member, err := writer.CreateHeader(header)
			if err != nil {
				return err
			}
			if _, err := member.Write(file.data); err != nil {
				return err
			}
		}
		return writer.Close()
	}
	compressed := gzip.NewWriter(output)
	writer := tar.NewWriter(compressed)
	for _, file := range files {
		if err := writer.WriteHeader(&tar.Header{Name: root + "/" + file.name, Mode: file.mode, Size: int64(len(file.data)), ModTime: time.Unix(0, 0)}); err != nil {
			return err
		}
		if _, err := writer.Write(file.data); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	return compressed.Close()
}
