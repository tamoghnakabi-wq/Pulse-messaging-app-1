# Pulse operations plan

Pragmatic ops roadmap so calls and multi-instance deploys stay reliable as usage grows.

**Deploy now (24/7):** [DEPLOY.md](./DEPLOY.md) · **Cloudflare Workers compatibility:** [CLOUDFLARE.md](./CLOUDFLARE.md) (Workers = not supported as-is).

## 1. Calls infrastructure

| Layer | Current | Production target |
|-------|---------|-------------------|
| Signaling | Socket.IO | Keep (or migrate to dedicated SFU control plane) |
| Media | Server-relayed PCM + JPEG | **TURN** for WebRTC peer paths; optional SFU for groups |
| Auth | Active call registry + membership | Same + Redis TTL so multi-node servers share call state |

**TURN:** Deploy coturn (or a managed TURN provider). Publish `TURN_URLS` / credentials to the client. Prefer TURN only when direct ICE fails.

**Why:** Relay-over-Socket works for tunnels and demos; scale and quality need real media infra.

## 2. Shared state & rate limits

| Concern | Current | Target |
|---------|---------|--------|
| Presence | In-memory maps | Redis sets + heartbeat TTLs |
| Call rooms | In-memory registries | Redis hashes with expiry |
| Rate limits | Per-process / per-IP | Redis-backed `express-rate-limit` store + socket buckets |
| 2FA challenges | In-memory | Redis with short TTL |

Single-node remains fine for small deployments; add Redis before horizontal scale-out.

## 3. Malware scanning

- Set `MALWARE_SCAN_CMD` to a scanner binary (e.g. ClamAV wrapper).
- In production, fail-closed is the default when a scanner is configured (`MALWARE_SCAN_FAIL_CLOSED` unless explicitly `false`).
- CI does not require a scanner; production should.

## 4. Observability

- Keep redacted security events.
- Ship logs to a host aggregator (JSON if possible).
- Alert on: spike failed logins, media unauthorized, malware rejects, call registry size.

## 5. CI / quality gates

- GitHub Actions: typecheck, lint, build on every PR.
- Integration smoke (`scripts/full-smoke-test.js`) against MongoDB service.
- Optional later: Playwright for auth + send-message UI.

## 6. Product focus reminder

Ops should support one sharp product promise (e.g. private messaging or network-resilient calls). Prefer chat excellence and reliable media over new surface area.
