package resource

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func frozen(t *testing.T, cfg Config) (*Manager, *time.Time) {
	t.Helper()
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC)
	m.now = func() time.Time { return now }
	return m, &now
}

func TestConnectionCapacityReleaseAndCrossReconnectRate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MaxConnections = 2
	cfg.MaxConnectionsPerIP = 1
	cfg.ConnectionsPerMinute = 3
	m, now := frozen(t, cfg)
	a, code := m.Admit("a")
	if code != "" {
		t.Fatal(code)
	}
	if _, code = m.Admit("a"); code != "connection_limit" {
		t.Fatal(code)
	}
	b, code := m.Admit("b")
	if code != "" {
		t.Fatal(code)
	}
	if _, code = m.Admit("c"); code != "server_busy" {
		t.Fatal(code)
	}
	a.Release()
	a.Release()
	a, code = m.Admit("a")
	if code != "" {
		t.Fatal(code)
	}
	a.Release()
	if _, code = m.Admit("a"); code != "connection_rate_limited" {
		t.Fatal("reconnect bypassed attempt limit", code)
	}
	*now = now.Add(time.Minute)
	a, code = m.Admit("a")
	if code != "" {
		t.Fatal(code)
	}
	a.Release()
	b.Release()
	if m.Snapshot().Connections != 0 {
		t.Fatal("connection capacity leaked")
	}
}

func TestPerIPBandwidthAndMessageLimitsSurviveSocketReplacement(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ClientBytesPerSecond = 100
	cfg.MessagesPerSecond = 1
	m, now := frozen(t, cfg)
	a, _ := m.Admit("a")
	b, _ := m.Admit("a")
	other, _ := m.Admit("b")
	if code := a.Outbound(120); code != "" {
		t.Fatal(code)
	}
	if code := b.Outbound(81); code != "bandwidth_limited" {
		t.Fatal("shared IP bypassed byte limit", code)
	}
	if code := other.Outbound(81); code != "" {
		t.Fatal("other IP was charged", code)
	}
	if code := a.Inbound(1); code != "" {
		t.Fatal(code)
	}
	if code := b.Inbound(1); code != "" {
		t.Fatal(code)
	}
	a.Release()
	a, _ = m.Admit("a")
	if code := a.Inbound(1); code != "message_rate_limited" {
		t.Fatal("new socket reset IP message budget", code)
	}
	*now = now.Add(time.Second)
	if code := a.Inbound(1); code != "" {
		t.Fatal("tokens did not replenish", code)
	}
}

func TestDailyQuotaIsAtomicAndStaticPagesRemainAvailable(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DailyBytes = 10
	m, now := frozen(t, cfg)
	a, _ := m.Admit("a")
	if code := a.Inbound(6); code != "" {
		t.Fatal(code)
	}
	if code := a.Outbound(5); code != "daily_quota_exceeded" {
		t.Fatal(code)
	}
	if code := m.ReserveHTTP("b", 4, true); code != "" {
		t.Fatal(code)
	}
	if code := m.ReserveHTTP("b", 1, true); code != "daily_quota_exceeded" {
		t.Fatal(code)
	}
	if code := m.ReserveHTTP("b", 1, false); code != "" {
		t.Fatal("static content consumed daily relay quota", code)
	}
	if m.Snapshot().DailyReservedBytes != 10 {
		t.Fatal("failed reservation changed quota")
	}
	*now = time.Date(2030, 1, 2, 0, 0, 0, 0, time.UTC)
	if code := a.Outbound(10); code != "" {
		t.Fatal("UTC daily budget did not reset", code)
	}
}

func TestGlobalBandwidthAndRequestBudgets(t *testing.T) {
	cfg := DefaultConfig()
	cfg.GlobalBytesPerSecond = 100
	cfg.HTTPRequestsPerMinute = 2
	m, now := frozen(t, cfg)
	a, _ := m.Admit("a")
	b, _ := m.Admit("b")
	if code := a.Outbound(150); code != "" {
		t.Fatal(code)
	}
	if code := b.Outbound(51); code != "bandwidth_limited" {
		t.Fatal("global byte budget bypassed", code)
	}
	if code := b.Outbound(50); code != "" {
		t.Fatal(code)
	}
	for range 2 {
		if code := m.AllowHTTP("a"); code != "" {
			t.Fatal(code)
		}
	}
	if code := m.AllowHTTP("a"); code != "request_rate_limited" {
		t.Fatal(code)
	}
	if code := m.AllowHTTP("b"); code != "" {
		t.Fatal(code)
	}
	*now = now.Add(time.Minute)
	if code := m.AllowHTTP("a"); code != "" {
		t.Fatal(code)
	}
}

func TestAnonymousAddressStateIsBoundedAndExpiredEntriesAreReclaimed(t *testing.T) {
	m, now := frozen(t, DefaultConfig())
	active, _ := m.Admit("active")
	for i := 1; i < MaxTrackedIPs; i++ {
		lease, code := m.Admit(fmt.Sprint(i))
		if code != "" {
			t.Fatal(code)
		}
		lease.Release()
	}
	if _, code := m.Admit("overflow"); code != "server_busy" {
		t.Fatal(code)
	}
	if m.Snapshot().TrackedIPs != MaxTrackedIPs {
		t.Fatal("unbounded IP map")
	}
	*now = now.Add(peerTTL)
	lease, code := m.Admit("replacement")
	if code != "" {
		t.Fatal(code)
	}
	if m.Snapshot().TrackedIPs != 2 {
		t.Fatal("inactive entries were not reclaimed, or active entry was lost")
	}
	active.Release()
	lease.Release()
}

func TestConcurrentAdmissionNeverExceedsCapacity(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MaxConnections = 7
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	leases := make(chan *Lease, 200)
	var wg sync.WaitGroup
	for i := range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lease, _ := m.Admit(fmt.Sprint(i))
			if lease != nil {
				leases <- lease
			}
		}()
	}
	wg.Wait()
	close(leases)
	if m.Snapshot().Connections != 7 {
		t.Fatal("concurrent admission exceeded or lost capacity", m.Snapshot())
	}
	for lease := range leases {
		lease.Release()
	}
	if m.Snapshot().Connections != 0 {
		t.Fatal("capacity not released")
	}
}

func TestConfigurationRejectsDisabledGuards(t *testing.T) {
	for _, field := range []string{"connections", "perIP", "attempts", "HTTP", "messages", "clientBytes", "globalBytes", "daily", "queue"} {
		t.Run(field, func(t *testing.T) {
			cfg := DefaultConfig()
			switch field {
			case "connections":
				cfg.MaxConnections = 0
			case "perIP":
				cfg.MaxConnectionsPerIP = 0
			case "attempts":
				cfg.ConnectionsPerMinute = 0
			case "HTTP":
				cfg.HTTPRequestsPerMinute = 0
			case "messages":
				cfg.MessagesPerSecond = 0
			case "clientBytes":
				cfg.ClientBytesPerSecond = 0
			case "globalBytes":
				cfg.GlobalBytesPerSecond = 0
			case "daily":
				cfg.DailyBytes = 0
			case "queue":
				cfg.MaxQueuedBytes = 0
			}
			if _, err := New(cfg); err == nil {
				t.Fatal("disabled guard accepted")
			}
		})
	}
}

func TestCodeLookupLimitSurvivesReconnectionAndDoesNotAffectOtherIPs(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ConnectionsPerMinute = 2
	m, _ := frozen(t, cfg)
	a, _ := m.Admit("a")
	if a.Request() != "" || a.Request() != "" {
		t.Fatal("valid request budget rejected")
	}
	a.Release()
	a, _ = m.Admit("a")
	if code := a.Request(); code != "connection_rate_limited" {
		t.Fatal("socket replacement reset code lookup quota", code)
	}
	b, _ := m.Admit("b")
	if b.Request() != "" {
		t.Fatal("another IP inherited lookup quota")
	}
}

func TestGlobalMessageAndHTTPBudgetsDoNotAllocateUnboundedPeerState(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MessagesPerSecond = 1
	m, _ := frozen(t, cfg)
	for i := range 9 {
		lease, _ := m.Admit(fmt.Sprint(i))
		code := lease.Inbound(1)
		if (i < 8 && code != "") || (i == 8 && code != "message_rate_limited") {
			t.Fatal("global message budget", i, code)
		}
	}
	m, _ = frozen(t, DefaultConfig())
	for i := range 201 {
		code := m.AllowHTTP(fmt.Sprint(i))
		if (i < 200 && code != "") || (i == 200 && code != "request_rate_limited") {
			t.Fatal("global HTTP budget", i, code)
		}
	}
	if m.Snapshot().TrackedIPs != 200 {
		t.Fatal("rejected HTTP requests allocated peer state")
	}
}
