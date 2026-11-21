package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"strings"
)

// These are ordinary compile-time resources, just like the embedded web pages.
// A plain go build is sufficient; the running program never opens its own EXE.
//
//go:embed THIRD_PARTY_NOTICES.txt
var distributionNotices string

//go:embed VERSION
var sourceVersion string

var buildVersion string
var buildCommit string
var buildDirty string

func applicationVersion() string {
	if buildVersion != "" {
		return buildVersion
	}
	return strings.TrimSpace(sourceVersion)
}

func distributionVersion() map[string]any {
	commit, modified := buildCommit, buildDirty == "true"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" && commit == "" {
				commit = setting.Value
			}
			if setting.Key == "vcs.modified" && buildDirty == "" {
				modified = setting.Value == "true"
			}
		}
	}
	return map[string]any{"version": applicationVersion(), "target": runtime.GOOS + "/" + runtime.GOARCH,
		"go": runtime.Version(), "commit": commit, "workingTreeModified": modified}
}

func handleDistributionInfo() (bool, error) {
	if len(os.Args) != 2 {
		return false, nil
	}
	switch os.Args[1] {
	case "-licenses":
		_, err := fmt.Fprint(os.Stdout, distributionNotices)
		return true, err
	case "-version":
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return true, encoder.Encode(distributionVersion())
	}
	return false, nil
}
