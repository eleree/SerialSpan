package main

import (
	"strings"
	"testing"
)

func TestDefaultBuildHasTheDeclaredProductVersion(t *testing.T) {
	if applicationVersion() != strings.TrimSpace(sourceVersion) || applicationVersion() == "" || applicationVersion() == "dev" {
		t.Fatal("ordinary go build lost its declared version")
	}
	if distributionVersion()["version"] != applicationVersion() {
		t.Fatal("reported version differs from product version")
	}
}
