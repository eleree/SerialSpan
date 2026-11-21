// Package resource bounds anonymous service usage without identifying users.
package resource

import (
	"errors"
	"sync"
	"time"
)

const (
	MaxTrackedIPs = 4096
	peerTTL       = 5 * time.Minute
)

type Config struct {
	MaxConnections        int
	MaxConnectionsPerIP   int
	ConnectionsPerMinute  int
	HTTPRequestsPerMinute int
	MessagesPerSecond     int
	ClientBytesPerSecond  int64
	GlobalBytesPerSecond  int64
	DailyBytes            int64
	MaxQueuedBytes        int64
}

func DefaultConfig() Config {
	return Config{
		MaxConnections: 64, MaxConnectionsPerIP: 8,
		ConnectionsPerMinute: 20, HTTPRequestsPerMinute: 120,
		MessagesPerSecond: 2000, ClientBytesPerSecond: 512 * 1024,
		GlobalBytesPerSecond: 2 * 1024 * 1024, DailyBytes: 2 * 1024 * 1024 * 1024,
		MaxQueuedBytes: 256 * 1024,
	}
}

type bucket struct {
	tokens, rate, burst float64
	last                time.Time
}

func newBucket(rate, burst float64, now time.Time) bucket {
	return bucket{tokens: burst, rate: rate, burst: burst, last: now}
}

func (b *bucket) refill(now time.Time) {
	if now.After(b.last) {
		b.tokens = min(b.burst, b.tokens+now.Sub(b.last).Seconds()*b.rate)
		b.last = now
	}
}

type peer struct {
	active                                      int
	last                                        time.Time
	connections, requests, http, data, messages bucket
}

type Stats struct {
	Connections, TrackedIPs                                        int
	Accepted, RejectedConnections, RejectedHTTP, RejectedTransfers uint64
	WSBytesIn, WSBytesOut, HTTPBytesOut, DailyReservedBytes        int64
}

type Manager struct {
	mu                     sync.Mutex
	cfg                    Config
	now                    func() time.Time
	peers                  map[string]*peer
	global, http, messages bucket
	lastSweep              time.Time
	day                    int64
	stats                  Stats
}

func New(cfg Config) (*Manager, error) {
	if cfg.MaxConnections <= 0 || cfg.MaxConnectionsPerIP <= 0 || cfg.ConnectionsPerMinute <= 0 ||
		cfg.HTTPRequestsPerMinute <= 0 || cfg.MessagesPerSecond <= 0 || cfg.ClientBytesPerSecond <= 0 ||
		cfg.GlobalBytesPerSecond <= 0 || cfg.DailyBytes <= 0 || cfg.MaxQueuedBytes <= 0 ||
		cfg.ClientBytesPerSecond > 1<<40 || cfg.GlobalBytesPerSecond > 1<<40 {
		return nil, errors.New("resource limits must be positive; byte rates must not exceed 1 TiB/s")
	}
	now := time.Now()
	return &Manager{cfg: cfg, now: time.Now, peers: make(map[string]*peer),
		global: newBucket(float64(cfg.GlobalBytesPerSecond), float64(cfg.GlobalBytesPerSecond)*2, now),
		http:   newBucket(100, 200, now), messages: newBucket(float64(cfg.MessagesPerSecond)*4, float64(cfg.MessagesPerSecond)*8, now),
		lastSweep: now, day: now.Unix() / 86400}, nil
}

func NewDefault() *Manager {
	manager, err := New(DefaultConfig())
	if err != nil {
		panic(err)
	}
	return manager
}
func (m *Manager) Config() Config { return m.cfg }

// peerLocked keeps anonymous address state bounded, including disconnected peers.
func (m *Manager) peerLocked(ip string, now time.Time) *peer {
	if now.Sub(m.lastSweep) >= time.Minute {
		for key, p := range m.peers {
			if p.active == 0 && now.Sub(p.last) >= peerTTL {
				delete(m.peers, key)
			}
		}
		m.lastSweep = now
	}
	if p := m.peers[ip]; p != nil {
		p.last = now
		return p
	}
	if len(m.peers) >= MaxTrackedIPs {
		return nil
	}
	p := &peer{last: now,
		connections: newBucket(float64(m.cfg.ConnectionsPerMinute)/60, float64(m.cfg.ConnectionsPerMinute), now),
		requests:    newBucket(float64(m.cfg.ConnectionsPerMinute)/60, float64(m.cfg.ConnectionsPerMinute), now),
		http:        newBucket(float64(m.cfg.HTTPRequestsPerMinute)/60, float64(m.cfg.HTTPRequestsPerMinute), now),
		data:        newBucket(float64(m.cfg.ClientBytesPerSecond), float64(m.cfg.ClientBytesPerSecond)*2, now),
		messages:    newBucket(float64(m.cfg.MessagesPerSecond), float64(m.cfg.MessagesPerSecond)*2, now)}
	m.peers[ip] = p
	return p
}

type Lease struct {
	manager        *Manager
	peer           *peer
	released       bool
	data, messages bucket
}

// Admit reserves capacity before allocating/upgrading a WebSocket. The caller
// releases the reservation on failed upgrades; Hub releases established peers.
func (m *Manager) Admit(ip string) (*Lease, string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	p := m.peerLocked(ip, now)
	code := ""
	if p == nil {
		code = "server_busy"
	} else {
		p.connections.refill(now)
		switch {
		case p.connections.tokens < 1:
			code = "connection_rate_limited"
		case m.stats.Connections >= m.cfg.MaxConnections:
			code = "server_busy"
		case p.active >= m.cfg.MaxConnectionsPerIP:
			code = "connection_limit"
		}
		if p.connections.tokens >= 1 {
			p.connections.tokens--
		}
	}
	if code != "" {
		m.stats.RejectedConnections++
		return nil, code
	}
	p.active++
	m.stats.Connections++
	m.stats.Accepted++
	return &Lease{manager: m, peer: p,
		data:     newBucket(float64(m.cfg.ClientBytesPerSecond), float64(m.cfg.ClientBytesPerSecond)*2, now),
		messages: newBucket(float64(m.cfg.MessagesPerSecond), float64(m.cfg.MessagesPerSecond)*2, now)}, ""
}

func (l *Lease) Release() {
	if l == nil {
		return
	}
	m := l.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if !l.released {
		l.released = true
		l.peer.active--
		l.peer.last = m.now()
		m.stats.Connections--
	}
}

func (m *Manager) AllowHTTP(ip string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	m.http.refill(now)
	if m.http.tokens < 1 {
		m.stats.RejectedHTTP++
		return "request_rate_limited"
	}
	m.http.tokens--
	p := m.peerLocked(ip, now)
	if p == nil {
		m.stats.RejectedHTTP++
		return "server_busy"
	}
	p.http.refill(now)
	if p.http.tokens < 1 {
		m.stats.RejectedHTTP++
		return "request_rate_limited"
	}
	p.http.tokens--
	return ""
}

func (m *Manager) reserveLocked(p *peer, l *Lease, n int64, metered bool, now time.Time) string {
	day := now.Unix() / 86400
	if day != m.day {
		m.day = day
		m.stats.DailyReservedBytes = 0
	}
	if metered && n > m.cfg.DailyBytes-m.stats.DailyReservedBytes {
		return "daily_quota_exceeded"
	}
	m.global.refill(now)
	p.data.refill(now)
	if l != nil {
		l.data.refill(now)
	}
	if n < 0 || m.global.tokens < float64(n) || p.data.tokens < float64(n) || (l != nil && l.data.tokens < float64(n)) {
		return "bandwidth_limited"
	}
	m.global.tokens -= float64(n)
	p.data.tokens -= float64(n)
	if l != nil {
		l.data.tokens -= float64(n)
	}
	if metered {
		m.stats.DailyReservedBytes += n
	}
	return ""
}

// HTTP bodies are admitted whole so rejected requests never receive truncated
// successful responses. Static pages are rate-limited but remain usable after
// the daily relay/sample budget is exhausted.
func (m *Manager) ReserveHTTP(ip string, n int64, metered bool) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	p := m.peerLocked(ip, now)
	if p == nil {
		m.stats.RejectedHTTP++
		return "server_busy"
	}
	code := m.reserveLocked(p, nil, n, metered, now)
	if code != "" {
		m.stats.RejectedHTTP++
	}
	return code
}

func (l *Lease) Inbound(n int) string {
	if l == nil {
		return ""
	}
	m := l.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stats.WSBytesIn += int64(n)
	if l.released {
		return "connection_closed"
	}
	now := m.now()
	l.peer.last = now
	l.messages.refill(now)
	l.peer.messages.refill(now)
	m.messages.refill(now)
	code := ""
	if l.messages.tokens < 1 || l.peer.messages.tokens < 1 || m.messages.tokens < 1 {
		code = "message_rate_limited"
	} else {
		l.messages.tokens--
		l.peer.messages.tokens--
		m.messages.tokens--
		code = m.reserveLocked(l.peer, l, int64(n), true, now)
	}
	if code != "" {
		m.stats.RejectedTransfers++
	}
	return code
}

// Outbound charges the source session for all recipients before forwarding.
// A relay fan-out therefore cannot multiply egress without consuming its quota.
func (l *Lease) Outbound(n int) string {
	if l == nil {
		return ""
	}
	m := l.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if l.released {
		return "connection_closed"
	}
	now := m.now()
	l.peer.last = now
	code := m.reserveLocked(l.peer, l, int64(n), true, now)
	if code != "" {
		m.stats.RejectedTransfers++
	}
	return code
}

// Registration/code lookup attempts share an IP bucket across socket changes.
func (l *Lease) Request() string {
	if l == nil {
		return ""
	}
	m := l.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if l.released {
		return "connection_closed"
	}
	now := m.now()
	l.peer.last = now
	l.peer.requests.refill(now)
	if l.peer.requests.tokens < 1 {
		m.stats.RejectedTransfers++
		return "connection_rate_limited"
	}
	l.peer.requests.tokens--
	return ""
}

func (m *Manager) RecordWSWrite(n int) { m.mu.Lock(); m.stats.WSBytesOut += int64(n); m.mu.Unlock() }
func (m *Manager) RecordHTTPWrite(n int) {
	if n > 0 {
		m.mu.Lock()
		m.stats.HTTPBytesOut += int64(n)
		m.mu.Unlock()
	}
}
func (m *Manager) Snapshot() Stats {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.stats
	s.TrackedIPs = len(m.peers)
	return s
}
