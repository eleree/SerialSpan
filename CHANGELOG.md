# Changelog

## Unreleased

## 0.1.0-beta.2-p2p.1 — SerialSpan GitHub preview (2026-11-22)

### Persistent monitoring reconnect

- Reconnect Remote after an unexpected socket or Local outage with 3/6/12/24/30-second backoff. Persist the last Local code, requested access and reconnect preference in the Remote browser; each reconnect submits a fresh authorization request and never reuses a grant. Manual disconnect, denial, approval timeout and resource-limit closure stop retries.
- Save Local's explicit automatic-accept preference in that browser. It remains off by default and only applies after sharing is registered; pausing remote operations, revoking a controller or a resource-limit shutdown clears the preference.

### Separate system diagnostics from serial I/O

- Keep Local and Remote terminals focused on RX/TX. Retain connection, authorization, P2P and reconnect events in a separate bounded buffer, exported on demand through Export system log; serial exports exclude those events.

### Keep Remote tools in one live session

- Switch between Remote serial and ESP32 flashing in the same document, reusing the current WebSocket and authorization. Direct visits to either route use the same shell; the active tool changes without reopening the page or requesting a second grant.

### Automatic UI language

- Select Chinese or English from the browser's preferred languages across Local, Remote, ESP32 flashing and the P2P experiment page, with no added runtime dependency.

### P2P TX queue protection

- Negotiate an optional TX-only WSS relay capability between the current Local and Remote. When Local's bounded unmatched direct-TX queue reaches 16 entries, route that Remote's subsequent writes through the existing authorized WSS FIFO while keeping its direct RX channel open; other Remotes remain unchanged.
- Cancel ambiguous in-flight direct writes without replaying them, reject later P2P TX permits for the switched Remote, and retain the existing full-link fallback for older pages that do not negotiate this capability.

### Durable failure diagnostics

- Include typed application failure sources, channel/SCTP errors and bounded assessment/buffer context in fallback snapshots. Freeze context before closing the probe, excluding serial payloads, addresses and raw browser error text.
- Log both socket-derived reporters once per grant and negotiation round. Keep the first fallback authoritative, suppress duplicate/retired asynchronous reports, and retain the existing fallback, retry and permission rules. Clearing the page log does not remove server journal records.

### Network reference for the current route

- Allow an approved receiver's ready notification to arrive after a confirmed initiator opens the diagnostic stream. Require the existing live data channel and current grant; keep serial TX confirmation rules unchanged. Cover delayed receiver notification explicitly in unit and native-browser tests.
- Count diagnostic JSON limits and traffic in UTF-8 bytes, including multibyte input, so control messages cannot bypass the byte budget.
- Select HTTP server sampling while relayed and a separate reliable/ordered diagnostic DataChannel while direct. Show the route, peer, effective upload/download, RTT and probe timeouts; allow Local to select among approved peers without rearranging the workspace.
- Bind assessment and results to the current peer, approval and direct attempt. Cancel on route changes; keep diagnostic bytes out of the UART, serial counters and command handlers. Read-only peers may assess the network. An unsupported diagnostic stream does not close the serial channel or silently switch measurement routes.
- Bound each P2P assessment to 128 KiB of sample payload, 20 seconds, one session per page and a 30-second cooldown. Reject work during serial transactions, periodic sending or RX backfill; retain existing HTTP sampling limits and leave device settings unchanged.

### Periodic sending and byte counters

- Finish an already submitted P2P TX intent once when periodic sending stops, while preventing new cycles. Clear stale write permits on permission/epoch changes without closing RX, and fence cancelled digests. Count a successfully submitted in-flight command even when the periodic job has just stopped.
- Add periodic sending to Local and Remote with fixed input bytes, 20–86400000 ms intervals, one in-flight submission and no catch-up burst. Stop on failure or loss of eligibility, preserve Local standalone operation, and fence cancelled queued writes and late P2P intents.
- Add independent RX/TX byte counters and reset controls. Preserve logs, receive cursors and streamed text decoding when resetting; count Local completed writes and Remote successful submissions, with UTF-8/HEX/line-ending bytes included.
- Correlate rejected P2P signals with their retired grant so a normal peer disconnect cannot replace current notices or stop a new periodic job. Keep server authorization strict.
- Verify periodic controls, exact bytes, counter reset, relay backfill/P2P live-tail merging and more than 256 live frames during held backfill in native Chromium with simulated serial streams; hardware and native Web Serial permission acceptance remain separate.

### Hybrid RX recovery

- Measure the 30-second RX backfill warning from verified receive-cursor progress instead of total transfer duration. Keep ongoing slow repair active, reject false progress, fence stale deadline callbacks, and clear only the matching stall notice after completion; cache and queue limits stay unchanged.
- Avoid disconnecting serial P2P receivers when live data fills the separate server replay-wait queue. Keep payloads in Local's bounded cache, advertise the latest cursor, and request another repair window after backfill. Preserve the legacy queue limits and all transport/authentication bounds.
- Keep live P2P reception active during WSS backfill. Buffer a bounded future tail, merge it in order only after historical acknowledgement, and request missing ranges after overflow without replaying TX commands or acknowledging unsent history.

### P2P connectivity diagnostics and optional STUN

- Negotiate optional bounded serial P2P retries without changing page layout or adding dependencies. Keep WSS available between up to four fresh PeerConnections, wait 5/10/20 seconds, and cap negotiation to a three-minute window. Validate rounds on the server and both endpoints, retain monotonic TX permits, fence old asynchronous work, and cancel on authorization loss. Protocol/byte validation and DTLS failures do not trigger retries; legacy peers keep single-attempt fallback. Cross-network success remains unverified.

- Preserve failure details before closing Native PeerConnection: switch data to WSS immediately, then capture once for at most 200 ms. Collect only typed DTLS/SCTP/ICE states and bounded candidate-pair counters, distinguish missing statistics from zero responses, and fence late results after authorization ends.
- Validate and forward first-failure details with a socket-derived reporter. Record redacted metadata automatically on the server; no raw SDP, candidate addresses, certificate IDs or serial payloads are logged.

- Allow up to 45 seconds for ordinary serial ICE negotiation while WSS stays usable. Avoid treating the previous 12-second application cutoff as a native ICE failure; keep early native failure, cancellation and late-event fences.

- Serve bounded same-origin ICE configuration from operator `-stun-urls`, with no external endpoint enabled by default and no new Go/runtime dependency in the application. Reject credentials, TURN URLs, excessive entries and malformed addresses; queries cannot override configuration.
- Explain negotiation stages, ICE states, candidate type counts and fallback causes in existing status tooltips and event logs, preserving page layout. Expose `getConnectionDiagnostics()` without raw SDP, addresses, grant IDs or raw browser errors; keep the pre-close failure snapshot.
- Relay only validated diagnostic reason codes within the approved pair, preserve the first failure, and log capabilities/state transitions on the server without repeating identical state logs. Authorization and serial queues are unchanged.

### Experimental serial P2P integration

- Negotiate ordered native WebRTC channels on the existing Local/Remote serial pages after approval. Preserve page markup/layout and controls, adding direct/relay text to existing connection status locations. Use host ICE only and automatically retain/fall back to WSS when direct connectivity is unavailable; do not add external services or runtime dependencies.
- Require a server-validated, monotonic TX permit binding length and SHA-256 to the real socket, port, grant and write epoch. Verify direct bytes at Local before entering the existing bounded serial FIFO, rechecking permissions after asynchronous digest and before physical writes. Abort incomplete direct writes without replaying them through WSS.
- Preserve one RX stream/cursor across transports. Broadcast lightweight heads and repair missing direct data, including a lost final frame, through the existing authenticated bounded cache/replay/ACK path. Freeze late live WSS frames until the server confirms replay, and fence late TX errors from newer authorizations. Keep pause, revocation, configuration and flash-exclusive rules; ESP32 flashing and control transactions remain WSS.
- Verify native Chrome and Edge with simulated serial streams: bidirectional exact bytes, no WSS payload during direct operation, reader injection, paused RX, legacy/direct mixed recipients, missing-tail recovery, relay TX, revocation and signaling loss. Also verify real COM5/COM6 at 115200 through a Win32 adapter and native Chrome/WebRTC; this does not verify browser Web Serial permissions or cross-machine/NAT.

### Experimental P2P probe

- Add an isolated, approval-gated `/experimental/p2p` page for synthetic binary transfers through native reliable/ordered WebRTC DataChannels, using no external ICE service. Keep physical serial and ESP32 paths unchanged.
- Restrict probe signaling and typed WSS fallback to the current approved synthetic pair, grant and port; recheck read/control, pause and write epochs at the receiver. Bound frames, buffering, ICE work and test memory; abort interrupted tests without automatic replay.
- Verify on Windows Chromium: bidirectional byte hashes, host/UDP selection, zero server data frames during direct transfer, reader injection rejection, pause/resume, automatic fallback after an in-flight channel closes, revocation and signaling cleanup. Cross-machine/NAT/hardware remain unverified.

### Distribution packages

- Set the product prerelease to `0.1.0-beta.1` in VERSION. Keep download filenames, ordinary-build CLI/startup output and Windows release file properties consistent; reject release/tag version mismatches. Generate standard Windows version resources before Go compilation, preserving the compiler output unchanged.
- Embed notices at Go compile time and derive version information from Go build metadata/link parameters. A plain `go build` produces a deployable EXE; release tooling copies it unchanged and never appends ZIP data or other resources after compilation.
- Replace Windows ZIP/script delivery with one native EXE containing the relay, pages, LAN setup, certificate generation and embedded notices. Keep configuration under LOCALAPPDATA/ShareSerial, preserve identity across EXE rename/update, and reject expired/mismatched certificates and busy ports before serving.
- Require explicit interactive consent for current-user certificate trust and private-network firewall changes; non-interactive mode makes neither change. Windows runs in one process and requires no PowerShell, extracted helpers or developer tools.
- Add Windows EXEs and Linux/macOS archives for amd64/arm64, checksums, build metadata and bundled dependency licenses. Exclude runtime secrets and refuse to overwrite a release directory.
- Add native single-EXE and extracted-archive startup checks, and a GitHub release workflow gated on CI. Version tags create draft prereleases; manual runs upload artifacts only. GitHub execution, certificate trust/UAC acceptance, signing/notarization and other-platform runtime acceptance remain unverified.

### Experimental Remote ESP32 toolbox

- Load the flasher SDK only when detecting a chip, before requesting the serial lock; allow preparation cancellation and retry with a fresh module URL after a failed load.
- Calculate compressed transfer progress using per-image fractions weighted by BIN size. Reserve 100% and success for reset, baud restoration and lock release; ignore callbacks from stopped sessions and preserve a newly approved connection during old-task cleanup.
- Add a Remote-side ESP32-C3/S3 flashing page that uses the approved shared serial connection to Local's physical port.
- Add capability negotiation for remote DTR/RTS and flash-exclusive sessions. Local and other Remotes cannot interleave writes while a flash session is active; pause, revoke, disconnect or timeout releases the lock.
- Bind forwarded DTR/RTS requests to the target Local ID as well as the authenticated Remote and flash session.
- Give relayed packet reads at least 30 seconds, including the ROM SYNC replies that esptool-js otherwise waits only 100 ms for; preserve longer erase/write deadlines.
- Bound compressed flash blocks to 2 KiB and browser send backlog to 64 KiB; allow a 90-second flash lease between renewals while preserving WebSocket heartbeats and immediate revocation.
- Use BIN-only ESP32 image/address rows with per-image selection; remove JSON manifest import. Revalidate alignment, overlap, capacity and file selection after edits; discard stale asynchronous verification and clear prior write confirmation. SHA-256 describes selected files without claiming a publisher hash match.
- Keep eight file/address rows and align the ESP32 page with Local/Remote styling: white panels, teal controls, rounded fields and dark logs, with SPI/device settings on the right. Allow draft file selection before connecting; keep validation and writing gated by the approved device session. Stop uses the existing Remote disconnect path.
- Verify the ESP32-S3 Hello World package over the public preview relay and a local proxy limited to 64 kbit/s per connection/direction with 100 ms one-way delay: all three images written, lock released and boot output received; subsequent native read-back checks match all three images.
- Preserve the Local, port and grant identifiers on expired serial-signal replies so Remote can reject its pending operation and report the timeout.
- Bundle Espressif esptool-js locally under its Apache-2.0 license; validate C3/S3 image layouts, explicit offsets and detected capacity, and compute SHA-256 before writing. The firmware bytes are relayed as serial data and are not stored as server files.
- Keep erase-all and eFuse operations unavailable. On 2026-10-22, Remote chip detection and a three-image IDF 5.3.2 Hello World write through a local relay passed on COM7 (ESP32-S3 QFN56 revision v0.2, 8 MB); all images passed `esptool verify_flash`, and Hello World output appeared in Local RX. ESP32-C3 and interrupted-write recovery remain unverified.

### Authorization protocol v3

- Require Local approval before exposing serial data or port metadata; default requests to read-only.
- Allow multiple approved writers and up to 16 Remotes per Local. Local can approve as read-only, deny or revoke; all writers share the same bounded serial FIFO.
- Bind decisions to the owning Local socket and a 128-bit request ID. Expire requests after 60 seconds and cap pending requests at 8 per Local.
- Cancel pending requests on disconnect/unshare; prevent stale approvals or slow-client cleanup from reviving grants.
- Check Local write permission at receipt and immediately before execution; revoke locally on button click. In-flight device writes cannot be rolled back.
- Add grant generations and pause/resume epochs. Pause retains RX/subscriptions, disables auto-accept and invalidates old queued Remote commands; resume waits for confirmation and never replays them.
- Require v3 for registration/connection and validate write metadata on both server and Local. Record completed Local TX source/enqueue order; label Remote TX as submitted.
- Add permission controls, protocol-version checks and authorization regression/mutation cases. Update both server and browser assets together.

### Weak-network RX recovery

- Add an optional v3 `rxReplayProtocol=1` extension. Local keeps a bounded 1 MiB/8192-frame/30-second RX cache in memory; an approved Remote can resume from its last sequence after reconnecting and receiving approval again.
- Add per-frame cumulative acknowledgements, duplicate filtering, explicit gap records for expired/evicted bytes, and a bounded 192 KiB per-Remote live queue while replay is in progress. Local paces replay uploads to 128 KiB/s with a 32 KiB burst to protect the shared service byte budget. New Remotes start at the live head; TX commands are never cached or replayed.
- Keep legacy v3 clients live-only when either endpoint does not negotiate receive replay.

### Changed

- Extend v3 with explicit `configProtocol=1`: full-control Remotes can change supported serial settings through Local; readers cannot. Serialize changes, freeze new writes, reject stale revisions/grants, confirm actual settings and attempt rollback; stop sharing on timeout or uncertain hardware state.
- Give Remote the same workspace layout as Local: main serial log, bottom send composer, connection sidebar and shared styles. Remove the explanatory note above the send input.
- Rename the Remote permission label to “完全控制” (full control) and remove queue hints; retain the existing shared write queue and Local-owned serial configuration.
- Bound anonymous service connection capacity, per-IP attempts/HTTP/messages/bytes, global bytes, daily relay/sample reservations and output queue bytes. Charge fan-out before forwarding; report limits without silent serial truncation.
- Connect Remote only on request and release cancelled/revoked/offline transports. Back off Local network retries and stop sharing on resource errors while preserving the serial port.
- Make Local a standalone serial assistant with direct text/HEX sends and configurable CR/LF endings; separate opening the device from remote sharing.
- Put the terminal in the main workspace and connection approvals in a sidebar; show the share code beside the sharing button.
- Support opt-in automatic approval for multiple readers and writers. Local remains writable while Remote senders are approved, and can pause all Remote writes without disconnecting them.
- Retain Local data and connection events separately, batch rendering, and bound unpainted rows during background-tab operation.
- Define one serial port per Local page; configuration is Local-owned.
- Replace shared mutable maps and per-subscription queues with Hub-owned session state.
- Broadcast RX to every matching Remote; bind sender identity to the WebSocket.
- Add register/unregister/disconnect acknowledgements and local_disconnected notifications.
- Reject legacy Remote config instead of silently ignoring it.
- Default to loopback HTTPS with configurable address/certificate/key paths.
- Embed static assets, so the built server can run without a separate static directory.
- Bound browser logs to 500 Local lines and 2000 Remote RX/TX records.

### Fixed

- Distinguish unapplied Remote parameter edits from Local-confirmed settings. Show Local request events and success/failure notices, including the source and old/new parameters.
- Allow more time for network reference samples on high-latency links and show HTTP, timeout, network and response-validation failures separately instead of hiding all non-timeout errors.
- Clean up failed connects, repeated connects, ID collisions and disconnected sessions.
- Re-register an open Local port after transport reconnect; reset Remote subscription state.
- Validate HEX bytes, append a real CR, and fix preset commands and clear TX.
- Preserve received bytes/timestamps across display-mode toggles and decode split UTF-8.
- Reject CR/LF-only Base64 strings that decode to an empty serial payload, discovered while strengthening negative tests.

### Added

- Add configurable resource budgets and aggregate usage logs without accounts, third-party telemetry or advertisements.
- Add opt-in Local/Remote network reference panels with bounded HTTP samples, latency/timeout statistics, cancellation and a conservative baud estimate. Never sample automatically or change serial settings; distinguish probe timeouts from IP packet loss.
- Correlate server WebSocket lifecycle, transport timeouts, queue overflow and Local ID conflicts without logging serial payloads or peer-supplied close reasons.
- Show Local reconnect/ID-change reasons and registration confirmations in the page log. Add diagnostic privacy and reconnect regression checks.
- Same-origin enforcement, role/port/data validation, heartbeat, deadlines and frame limits.
- Enforce a 16 KiB decoded serial payload limit on the server as well as browsers.
- Add an isolated, contract-focused mutation runner, explicit fault catalog and a CI mutation gate with retained reports. Build failures, timeouts and infrastructure errors never count as kills.
- Slow-client disconnection in place of silent queue drops and unbounded send goroutines.
- Unique development certificate generator, regression tests and cross-platform CI config.
- MIT license, contribution guide, maintenance constraints, security notes and roadmap.

### Removed

- Tracked development certificates, private key and binary from the working tree.
- Unsupported software flow control, 5/6 data bits and ineffective Remote parameter controls.

Protocol compatibility: update both pages and server together. Legacy register/connect requests receive protocol_mismatch. Inline connect config remains unsupported; authorized parameter changes require the explicitly advertised configuration extension. Physical write acknowledgement, delivery replay and account authentication remain unimplemented.
