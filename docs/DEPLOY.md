# Deploy Pulse 24/7 (without your Mac)

This guide runs the **existing Node/Express backend** always-on.

| Option | Platform | Command |
|--------|----------|---------|
| **A** | VPS + Docker Compose | `docker compose up -d --build` |
| **B** | Fly.io | `fly deploy` |
| **C** | Cloudflare Tunnel (edge only) | `cloudflared tunnel run` |
| **D** | **Cloudflare Containers** (`wrangler deploy`) | `npm run cf:deploy` |

Option **D** is the path when you want **Cloudflare Worker-style deploy** without rewriting Express. Details: [CLOUDFLARE.md](./CLOUDFLARE.md).

## Prerequisites

- Docker + Docker Compose on the host (A/B/D)  
- Strong secrets for JWT  
- Optional: [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) (required for Fly / Cloudflare Containers)  
- Optional: Cloudflare account for Tunnel and/or Containers  

---

## Option A — Single VPS + Docker Compose (simplest)

### 1. Provision a small Linux VPS

1–2 GB RAM minimum. Ubuntu 22.04+ is fine.

### 2. Clone and configure

```bash
git clone <your-repo-url> pulse
cd pulse

export JWT_ACCESS_SECRET="$(openssl rand -hex 48)"
export JWT_REFRESH_SECRET="$(openssl rand -hex 48)"
export CLIENT_URL="https://your-domain.example"
export API_URL="https://your-domain.example"
export CORS_ORIGINS="https://your-domain.example"
export COOKIE_SECURE=true
```

Create a root `.env` (compose reads `${JWT_*}` from the environment or a `.env` next to `docker-compose.yml`):

```env
JWT_ACCESS_SECRET=...long random...
JWT_REFRESH_SECRET=...long random...
CLIENT_URL=https://your-domain.example
API_URL=https://your-domain.example
CORS_ORIGINS=https://your-domain.example
COOKIE_SECURE=true
```

### 3. Start stack

```bash
docker compose up -d --build
```

Services:

| Service | Role | Port on host |
|---------|------|----------------|
| `frontend` | nginx static + `/api` proxy | **80** |
| `backend` | Express + Socket.IO | **5000** (internal + published) |
| `mongodb` | data | internal only |

Health check:

```bash
curl -s http://127.0.0.1:5000/api/health
curl -s http://127.0.0.1/   # frontend
```

### 4. TLS

- **Easy:** Cloudflare Tunnel (Option C) or Cloudflare DNS proxy + origin cert  
- **Classic:** Caddy/nginx reverse proxy with Let’s Encrypt on the VPS

---

## Option B — Fly.io (Docker, always-on)

```bash
# Install flyctl, then from repo root:
fly launch --no-deploy   # create app; use backend Dockerfile or full compose strategy
```

Minimal path for **API only** + Atlas Mongo:

1. Set secrets:

```bash
fly secrets set \
  JWT_ACCESS_SECRET=... \
  JWT_REFRESH_SECRET=... \
  MONGODB_URI='mongodb+srv://...' \
  CLIENT_URL=https://your-frontend.example \
  API_URL=https://your-api.fly.dev \
  CORS_ORIGINS=https://your-frontend.example \
  COOKIE_SECURE=true \
  NODE_ENV=production \
  PORT=8080
```

2. Deploy backend with `fly.toml` (see repo `fly.toml` if present).

3. Deploy frontend to Cloudflare Pages / Netlify / Fly static with `VITE_API_URL` pointing at the Fly API **and** matching Socket.IO origin (same API host preferred).

**Note:** Socket.IO needs sticky sessions if you scale to multiple machines. Stay at **1 machine** until Redis-backed presence is implemented (see OPS.md).

---

## Option D — Cloudflare Containers (`wrangler deploy`)

Runs the **same** `backend/Dockerfile` inside Cloudflare Containers. A thin Worker proxies REST + Socket.IO.

```bash
# Docker must be running. Workers Paid required.
npx wrangler login
npx wrangler secret put JWT_ACCESS_SECRET
npx wrangler secret put JWT_REFRESH_SECRET
npx wrangler secret put MONGODB_URI

# Edit wrangler.jsonc vars (CLIENT_URL, API_URL, CORS_ORIGINS), then:
npm run cf:deploy
```

Full steps, architecture, and limits (ephemeral uploads, single instance): **[CLOUDFLARE.md](./CLOUDFLARE.md)**.

---

## Option C — Cloudflare Tunnel (edge only, not Workers)

Run the **same Docker stack** on a VPS, then expose it via a **named** Cloudflare Tunnel (24/7, no open ports if you want):

```bash
# On the VPS, after compose is up:
cloudflared tunnel login
cloudflared tunnel create pulse
cloudflared tunnel route dns pulse app.yourdomain.com
```

Example `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /root/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: app.yourdomain.com
    service: http://127.0.0.1:80
  - service: http_status:404
```

```bash
cloudflared tunnel run pulse
```

Then set:

```env
CLIENT_URL=https://app.yourdomain.com
API_URL=https://app.yourdomain.com
CORS_ORIGINS=https://app.yourdomain.com
```

and recreate containers so the API picks up CORS.

Quick tunnels (`*.trycloudflare.com` from `npm run dev`) **die when your Mac sleeps** — they are for local dev only.

---

## Uploads and data

| Data | Default | Production tip |
|------|---------|----------------|
| MongoDB | compose volume `pulse_mongo_data` | Prefer **Atlas** + backup |
| Media files | compose volume `pulse_uploads` | Back up volume; later move to S3/R2 |
| Secrets | env / host secrets | Never commit JWT secrets |

---

## Checklist before going live

- [ ] Strong unique `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`  
- [ ] `COOKIE_SECURE=true` and HTTPS only  
- [ ] CORS locked to your real origin(s)  
- [ ] Mongo reachable and backed up  
- [ ] `docker compose ps` shows `restart: unless-stopped` healthy  
- [ ] `/api/health` returns ok from the public URL  
- [ ] Socket.IO connects (browser Network → WS)  
- [ ] Optional: `MALWARE_SCAN_CMD` if you require AV  

---

## What we are *not* doing

- Running Express **inside a pure Workers isolate** (no Containers)  
- Replacing Socket.IO with Durable Objects in this pass  
- Requiring your Mac or a laptop quick-tunnel for production  

**We are** supporting **Cloudflare Containers** via `wrangler deploy` — see [CLOUDFLARE.md](./CLOUDFLARE.md).
