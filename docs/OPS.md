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

Uploads (chat attachments, avatars, covers, group avatars) call `scanUploadedFile` before they are accepted.

### Docker Compose (recommended)

Compose includes a **ClamAV** service and wires the API automatically:

```yaml
MALWARE_SCAN_CMD=/app/malware-scan.sh
MALWARE_SCAN_FAIL_CLOSED=true
CLAMD_HOST=clamav
```

```bash
docker compose up -d --build
# First ClamAV start downloads virus defs (several minutes). Watch:
docker compose logs -f clamav
```

Backend image ships `clamdscan` + `/app/malware-scan.sh`, which streams files to `clamav:3310`.

### Manual / host install

```bash
# macOS example
brew install clamav
# or use the wrapper against a remote clamd:
export MALWARE_SCAN_CMD="/path/to/pulse/backend/scripts/malware-scan.sh"
export CLAMD_HOST=127.0.0.1
export CLAMD_PORT=3310
```

Or a direct binary with args:

```bash
export MALWARE_SCAN_CMD="clamdscan --no-summary --stream"
```

### Behaviour

| Env | Meaning |
|-----|---------|
| `MALWARE_SCAN_CMD` unset | No scan (dev default) |
| Scanner exit **0** | Clean — accept |
| Scanner exit **1** | Infected — reject (`MALWARE_BLOCKED`) |
| Scanner error / timeout | Reject if fail-closed (production default when cmd is set) |

- Production defaults **fail-closed** when a scanner is configured (`MALWARE_SCAN_FAIL_CLOSED` unless explicitly `false`).
- CI does not require ClamAV; unit tests mock a fake scanner (`npm run test:malware`).
- Fly / Cloudflare Containers: run ClamAV as a sidecar or leave `MALWARE_SCAN_CMD` unset until you have a reachable `clamd` (otherwise fail-closed will reject all uploads).

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
