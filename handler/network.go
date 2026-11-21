package handler

import (
	"crypto/rand"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"shareserial/resource"
)

const MaxNetworkSampleBytes = 256 * 1024

// NetworkSample serves only bounded, generated data. It never accesses a serial
// session, proxies another URL, or retains a measurement.
func NetworkSample(c *gin.Context) {
	networkSample(c, nil)
}

func NetworkSampleLimited(manager *resource.Manager) gin.HandlerFunc {
	return func(c *gin.Context) { networkSample(c, manager) }
}

func networkSample(c *gin.Context, manager *resource.Manager) {
	c.Header("Cache-Control", "no-store, no-transform")
	count := 0
	if values, present := c.Request.URL.Query()["bytes"]; present {
		if len(values) != 1 {
			c.Status(http.StatusBadRequest)
			return
		}
		value, err := strconv.Atoi(values[0])
		if err != nil || value < 0 || value > MaxNetworkSampleBytes {
			c.Status(http.StatusBadRequest)
			return
		}
		count = value
	}
	if count == 0 {
		c.Status(http.StatusNoContent)
		return
	}
	if manager != nil {
		if code := manager.ReserveHTTP(c.ClientIP(), int64(count), true); code != "" {
			c.Header("Retry-After", "60")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": code, "error": "Network assessment quota reached; retry later"})
			return
		}
	}
	data := make([]byte, count)
	if _, err := rand.Read(data); err != nil {
		c.Status(http.StatusServiceUnavailable)
		return
	}
	c.Header("Content-Encoding", "identity")
	c.Header("X-Network-Sample-Bytes", strconv.Itoa(count))
	c.Data(http.StatusOK, "application/octet-stream", data)
}
