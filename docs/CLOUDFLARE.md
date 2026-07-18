# Pulse and Cloudflare

## Short answer (2026)

**Pure Cloudflare Workers isolates cannot run the Pulse backend as-is** (Express + Socket.IO + Mongoose + disk uploads + in-process schedulers).

**You can still deploy with `wrangler deploy`** using **[Cloudflare Containers](https://developers.cloudflare.com/containers/)**: a thin Worker routes HTTP and WebSocket traffic into a **Docker image** of the real Node API (`backend/Dockerfile`). That is the supported path in this repo — not a multi-month rewrite to Durable Objects.

| Path | What it is | Pulse fit |
|------|------------|-----------|
| **Workers isolates only** | Request-scoped JS, no classic `server.listen` | ❌ No (would need full rewrite) |
| **Cloudflare Containers** | Worker + Docker container via Wrangler | ✅ Yes — `npx wrangler deploy` |
| **Tunnel / DNS only** | Edge in front of Fly/VPS | ✅ Yes — see DEPLOY.md |

---

## Deploy API on Cloudflare Containers

### Prerequisites

1. **Workers Paid** plan (Containers are paid)
2. **Docker** running locally (`docker info` succeeds) — Wrangler builds the image on deploy
3. **MongoDB Atlas** (or any Mongo reachable from the public internet) — Containers do not run Mongo for you
4. Cloudflare account: `npx wrangler login`

### 1. Configure public URLs

Edit root [`wrangler.jsonc`](../wrangler.jsonc) `vars`:

```jsonc
"vars": {
  "CLIENT_URL": "https://your-frontend.example",
  "API_URL": "https://pulse-api.<YOUR_SUBDOMAIN>.workers.dev",
  "CORS_ORIGINS": "https://your-frontend.example"
}
```

After the first deploy, set `API_URL` / CORS to your real `*.workers.dev` (or custom domain) URL and redeploy.

### 2. Set secrets

```bash
cd /path/to/pulse

npx wrangler secret put JWT_ACCESS_SECRET    # ≥32 chars, not a placeholder
npx wrangler secret put JWT_REFRESH_SECRET
npx wrangler secret put MONGODB_URI          # mongodb+srv://...
# recommended:
npx wrangler secret put MEDIA_SIGNING_SECRET
```

### 3. Deploy

```bash
# From repo root (Docker must be running)
npm run cf:deploy
# same as: npx wrangler deploy
```

Wrangler will:

1. Build `backend/Dockerfile` (linux/amd64)
2. Push the image to Cloudflare’s container registry
3. Deploy the Worker (`cloudflare/src/index.ts`) that proxies all traffic to **one sticky** container instance

First provision can take **several minutes**. Then:

```bash
curl -sS https://pulse-api.<YOUR_SUBDOMAIN>.workers.dev/api/health
curl -sS https://pulse-api.<YOUR_SUBDOMAIN>.workers.dev/__worker_health
```

### 4. Point the frontend at the Worker

Build or host the SPA with:

```env
VITE_API_URL=https://pulse-api.<YOUR_SUBDOMAIN>.workers.dev
VITE_SOCKET_URL=https://pulse-api.<YOUR_SUBDOMAIN>.workers.dev
```

Frontend can still be **Cloudflare Pages**, Netlify, or any static host. Keep `CORS_ORIGINS` / `CLIENT_URL` aligned with that origin.

### Architecture

```
Browser
  → Workers edge (pulse-api Worker)
       → single Container instance (Node Express + Socket.IO)
            → MongoDB Atlas
            → ephemeral disk for /app/uploads  ⚠️ not durable across restarts
```

**Why one instance?** Socket.IO, presence, call relay, and game state are in-process. Scale to many containers only after Redis (see [OPS.md](./OPS.md)).

**Uploads:** Container disk is **ephemeral**. Media will disappear when the container is replaced. For production media, move to R2/S3 later; for beta, accept ephemeral disk or use Fly/VPS with a volume.

**Sleep:** The container uses `sleepAfter = 24h`. After long idle it may cold-start on the next request (first hit slower). Active WebSocket traffic keeps it awake.

---

## What pure Workers still cannot do (without rewrite)

| Pulse feature | Pure Workers isolate | Containers (this repo) |
|---------------|----------------------|-------------------------|
| REST API (Express) | Rewrite to Hono/itty | ✅ Same Node code |
| Socket.IO realtime | Custom DO protocol | ✅ Proxied WebSockets |
| File uploads on disk | Need R2 | ⚠️ Works, ephemeral disk |
| Mongoose + Mongo | Hyperdrive / external | ✅ Outbound to Atlas |
| Game scheduler | Cron + external state | ✅ `setInterval` in process |

A pure-isolate rewrite remains multi-month (HTTP → DO websockets → R2 → Cron). **Do not** expect `backend/` Express sources to run inside an isolate.

---

## Alternatives (non-Workers)

For always-on **without** Containers billing, use Docker/Fly/VPS + optional Tunnel:

- [DEPLOY.md](./DEPLOY.md) — compose, Fly, named Tunnel
- [OPS.md](./OPS.md) — multi-instance, Redis, TURN

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Deploy fails building image | Docker daemon running; `docker info` |
| Container errors on boot | Secrets set? JWT length ≥32? `MONGODB_URI` reachable? |
| CORS errors | `CORS_ORIGINS` / `CLIENT_URL` match frontend origin exactly |
| Socket.IO fails | Use same host for API + socket (`VITE_SOCKET_URL`); wait for provision |
| 502 after deploy | Wait a few minutes; `npx wrangler containers list` |
| Lost uploads after redeploy | Expected (ephemeral disk) — use R2/volume later |

Useful commands:

```bash
npx wrangler containers list
npx wrangler containers images list
npx wrangler tail
```

---

## Related

- Worker entry: [`cloudflare/src/index.ts`](../cloudflare/src/index.ts)
- Wrangler config: [`wrangler.jsonc`](../wrangler.jsonc)
- API image: [`backend/Dockerfile`](../backend/Dockerfile)
- [DEPLOY.md](./DEPLOY.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)
