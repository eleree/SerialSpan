package main

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"shareserial/resource"
)

// STUN configuration belongs to the deployment, never to a connection request.
// No third-party service or TURN credential is bundled into the default build.
func parseSTUNURLs(value string) ([]string, error) {
	urls := []string{}
	invalid := errors.New("specify at most four stun:host[:port] URLs without credentials, paths or queries")
	if len(value) > 1024 || strings.ContainsAny(value, "\r\n\t") {
		return nil, invalid
	}
	if strings.TrimSpace(value) == "" {
		return urls, nil
	}
	seen := map[string]bool{}
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if !strings.HasPrefix(item, "stun:") || len(item) > 256 || strings.ContainsAny(item, "\r\n\t /\\?#@<>") {
			return nil, invalid
		}
		authority := strings.TrimPrefix(item, "stun:")
		host, port := authority, "3478"
		if strings.HasPrefix(authority, "[") && strings.HasSuffix(authority, "]") {
			host = strings.TrimSuffix(strings.TrimPrefix(authority, "["), "]")
			if net.ParseIP(host) == nil || !strings.Contains(host, ":") {
				return nil, invalid
			}
		} else if strings.Contains(authority, ":") {
			var err error
			host, port, err = net.SplitHostPort(authority)
			if err != nil {
				return nil, invalid
			}
		}
		if host == "" || len(host) > 253 {
			return nil, invalid
		}
		if net.ParseIP(host) == nil {
			for _, label := range strings.Split(host, ".") {
				if len(label) == 0 || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
					return nil, invalid
				}
				for _, char := range label {
					if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-') {
						return nil, invalid
					}
				}
			}
		}
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return nil, invalid
		}
		if !seen[item] {
			urls = append(urls, item)
			seen[item] = true
		}
		if len(urls) > 4 {
			return nil, invalid
		}
	}
	return urls, nil
}

func iceConfigurationScript(urls []string, manager *resource.Manager) gin.HandlerFunc {
	servers := []map[string][]string{}
	if len(urls) != 0 {
		servers = append(servers, map[string][]string{"urls": urls})
	}
	encoded, _ := json.Marshal(gin.H{"schemaVersion": 1, "iceServers": servers})
	body := append([]byte("globalThis.ShareSerialICE=Object.freeze("), encoded...)
	body = append(body, []byte(");\n")...)
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if code := manager.ReserveHTTP(c.ClientIP(), int64(len(body)), false); code != "" {
			c.Header("Retry-After", "60")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": code})
			return
		}
		c.Data(http.StatusOK, "application/javascript; charset=utf-8", body)
	}
}
