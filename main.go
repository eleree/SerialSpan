package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"shareserial/handler"
	"shareserial/resource"
	"shareserial/websocket"
)

//go:embed static
var assets embed.FS

func newRouter(hub *websocket.Hub) *gin.Engine {
	r, err := newRouterTrusted(hub, nil)
	if err != nil {
		panic(err)
	}
	return r
}

func newRouterTrusted(hub *websocket.Hub, trustedProxies []string, stunConfiguration ...string) (*gin.Engine, error) {
	stunURLs, err := parseSTUNURLs(strings.Join(stunConfiguration, ","))
	if err != nil {
		return nil, err
	}
	r := gin.Default()
	if err := r.SetTrustedProxies(trustedProxies); err != nil {
		return nil, err
	}
	pages, err := fs.Sub(assets, "static")
	if err != nil {
		panic(err)
	}
	manager := hub.Resources()
	r.Use(func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("Permissions-Policy", "serial=(self)")
		if code := manager.AllowHTTP(c.ClientIP()); code != "" {
			c.Header("Retry-After", "60")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": code, "error": "Too many requests; retry later"})
			manager.RecordHTTPWrite(c.Writer.Size())
			return
		}
		c.Next()
		manager.RecordHTTPWrite(c.Writer.Size())
	})

	serveAsset := func(c *gin.Context, name string) {
		if !fs.ValidPath(name) {
			c.Status(http.StatusNotFound)
			return
		}
		body, err := fs.ReadFile(pages, name)
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		if code := manager.ReserveHTTP(c.ClientIP(), int64(len(body)), false); code != "" {
			c.Header("Retry-After", "60")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"code": code, "error": "Service bandwidth is busy; retry later"})
			return
		}
		contentType := mime.TypeByExtension(path.Ext(name))
		if contentType == "" {
			contentType = http.DetectContentType(body)
		}
		c.Header("Cache-Control", "no-cache")
		// Serve a complete bounded body; Range requests cannot amplify output.
		c.Data(http.StatusOK, contentType, body)
	}
	r.GET("/static/*filepath", func(c *gin.Context) { serveAsset(c, strings.TrimPrefix(c.Param("filepath"), "/")) })
	r.GET("/api/network-sample", handler.NetworkSampleLimited(manager))
	r.GET("/api/serial-p2p-config.js", iceConfigurationScript(stunURLs, manager))

	// HTML pages
	r.GET("/", func(c *gin.Context) {
		serveAsset(c, "index.html")
	})
	r.GET("/local", func(c *gin.Context) {
		serveAsset(c, "local.html")
	})
	r.GET("/remote", func(c *gin.Context) {
		serveAsset(c, "remote.html")
	})
	r.GET("/remote/esp32", func(c *gin.Context) {
		serveAsset(c, "remote.html")
	})
	r.GET("/experimental/p2p", func(c *gin.Context) { serveAsset(c, "p2p-probe.html") })

	// WebSocket handlers
	h := handler.New(hub)
	r.GET("/ws/local", h.Local)
	r.GET("/ws/remote", h.Remote)
	return r, nil
}

func main() {
	if handled, err := desktopEntry(); handled || err != nil {
		if err != nil {
			fmt.Fprintln(os.Stderr, "ShareSerial:", err)
			if len(os.Args) == 1 {
				fmt.Print("按回车关闭窗口…")
				_, _ = fmt.Scanln()
			}
			os.Exit(1)
		}
		return
	}
	addr := flag.String("addr", "127.0.0.1:12345", "HTTPS listen address")
	cert := flag.String("cert", ".local/certs/cert.pem", "TLS certificate path")
	key := flag.String("key", ".local/certs/key.pem", "TLS private key path")
	trusted := flag.String("trusted-proxies", "", "Comma-separated trusted reverse proxy IPs/CIDRs; none by default")
	stun := flag.String("stun-urls", "", "Optional comma-separated STUN URLs for serial P2P, for example stun:stun.example.org:3478")
	limits := resource.DefaultConfig()
	flag.IntVar(&limits.MaxConnections, "max-connections", limits.MaxConnections, "Maximum simultaneous WebSockets")
	flag.IntVar(&limits.MaxConnectionsPerIP, "max-connections-per-ip", limits.MaxConnectionsPerIP, "Maximum simultaneous WebSockets per client IP")
	flag.IntVar(&limits.ConnectionsPerMinute, "connections-per-minute", limits.ConnectionsPerMinute, "New WebSocket attempts per minute per IP")
	flag.IntVar(&limits.HTTPRequestsPerMinute, "http-requests-per-minute", limits.HTTPRequestsPerMinute, "HTTP requests per minute per IP")
	flag.IntVar(&limits.MessagesPerSecond, "messages-per-second", limits.MessagesPerSecond, "Application messages per second per WebSocket")
	flag.Int64Var(&limits.ClientBytesPerSecond, "client-bytes-per-second", limits.ClientBytesPerSecond, "Application byte rate per IP and source session; two-second burst")
	flag.Int64Var(&limits.GlobalBytesPerSecond, "global-bytes-per-second", limits.GlobalBytesPerSecond, "Global application byte rate; two-second burst")
	flag.Int64Var(&limits.DailyBytes, "daily-transfer-bytes", limits.DailyBytes, "Daily UTC relay/sample application byte budget; resets on restart")
	flag.Int64Var(&limits.MaxQueuedBytes, "max-queued-bytes", limits.MaxQueuedBytes, "Maximum queued output bytes per WebSocket")
	flag.Parse()
	manager, err := resource.New(limits)
	if err != nil {
		log.Fatal(err)
	}
	var proxies []string
	if *trusted != "" {
		proxies = strings.Split(*trusted, ",")
	}
	hub := websocket.NewHubWithResources(manager)
	router, err := newRouterTrusted(hub, proxies, *stun)
	if err != nil {
		log.Fatalf("Invalid server configuration: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go hub.Run(ctx)
	server := &http.Server{
		Addr:              *addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	result := make(chan error, 1)
	go func() { result <- server.ListenAndServeTLS(*cert, *key) }()
	log.Printf("ShareSerial listening on https://%s", *addr)
	select {
	case err := <-result:
		if err != nil && err != http.ErrServerClosed {
			log.Printf("Server failed: %v; check the listen address and HTTPS configuration", err)
			stop()
			os.Exit(1)
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("Shutdown: %v", err)
		}
	}
}
