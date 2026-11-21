//go:build !windows

package main

func desktopEntry() (bool, error) {
	return handleDistributionInfo()
}
