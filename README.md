# Pulse

Production-quality real-time messaging platform inspired by Discord, WhatsApp Web, and Telegram.

**Stack:** React 19 · TypeScript · Vite · Tailwind CSS · Node.js · Express · Socket.IO · MongoDB · JWT · Framer Motion · Zustand · React Query · Docker

**Architecture:** See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for folder layout, domain services, and contribution conventions.

---

## Features

### Authentication
- Register / Login with JWT access + refresh tokens  
- bcrypt password hashing  
- Forgot / reset password (SMTP or dev console logs)  
- Email verification  
- Session management & logout everywhere  

### Messaging
- One-to-one & group chats  
- Real-time delivery via Socket.IO  
- Reactions, reply, forward, edit  
- Delete for me / delete for everyone  
- Pin & star messages  
- Search, timestamps, infinite scroll  
- Typing indicators, read & delivered receipts  

### Media & voice
- Images, video, audio, documents  
- Drag & drop, previews, progress bars  
- Voice notes  
- WebRTC voice / video calls & screen sharing  

### UI
- Apple-inspired glassmorphism  
- Dark / light / system themes  
- Responsive mobile + desktop layouts  
- Skeleton loaders & Framer Motion transitions  

---

## Quick start

### Prerequisites
- Node.js 20+
- npm 10+
- Docker (for local MongoDB) **or** a MongoDB Atlas URI
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) on your PATH (`brew install cloudflared`)

### 1. Install

```bash
cd pulse
npm run setup
```

This installs workspaces and generates `backend/.env` + `frontend/.env`.

### 2. Database

**Option A — Local MongoDB (Docker):**

```bash
docker compose up -d mongodb
```

Default URI: `mongodb://localhost:27017/pulse`  
(With compose auth: set `MONGODB_URI=mongodb://pulse:pulse_secret@localhost:27017/pulse?authSource=admin`)

**Option B — MongoDB Atlas:**

Edit `backend/.env`:

```env
MONGODB_URI=mongodb+srv://USER:PASS@cluster.mongodb.net/pulse?retryWrites=true&w=majority
```

### 3. Run (backend + frontend + Cloudflare tunnel)

```bash
npm run dev
```

The orchestrator will:
1. Ensure MongoDB is available (Docker `pulse-mongodb` if needed)
2. Start the Vite app on port **5173**
3. Open a **Cloudflare** public tunnel to the frontend (`cloudflared`)
4. Start the API on port **5050** (avoids macOS AirPlay on :5000)
5. Configure CORS / env for the public domain
6. Print the **public URL**

```
Local frontend : http://localhost:5173
Local API      : http://localhost:5050
Public URL     : https://xxxx.trycloudflare.com
```

Open the public URL (or local) → **Register** two accounts → start chatting.

**Tunnel options**

| Mode | How |
|------|-----|
| Quick tunnel (default) | `cloudflared tunnel --url http://127.0.0.1:5173` — no login required |
| Named Zero Trust tunnel | set `TUNNEL_TOKEN` + `PULSE_PUBLIC_URL=https://your.domain` |
| You run cloudflared yourself | set `PULSE_PUBLIC_URL=https://your.domain` before `npm run dev` |

### Local only (no public tunnel)

```bash
npm run dev:local
```

---

## Environment variables

### Backend (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `PORT` | API port (default `5050`) |
| `MONGODB_URI` | MongoDB connection string |
| `JWT_ACCESS_SECRET` | Access token secret |
| `JWT_REFRESH_SECRET` | Refresh token secret |
| `CLIENT_URL` | Frontend origin (CORS + emails) |
| `API_URL` | Public API base (avatar URLs) |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| `UPLOAD_DIR` | File upload directory |
| `SMTP_*` | Optional email delivery |
| `COOKIE_SECURE` | `true` behind HTTPS / Cloudflare |

### Frontend (`frontend/.env`)

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | API origin (empty = same origin / proxy) |
| `VITE_SOCKET_URL` | Socket origin (optional) |

With Cloudflare, `VITE_API_URL` is left empty so the Vite proxy handles `/api`, `/uploads`, and `/socket.io` — Socket.IO works over a single tunnel without a second process.

---

## Project structure

```
pulse/
├── backend/
│   ├── src/
│   │   ├── config/          # Env + MongoDB
│   │   ├── controllers/     # Route handlers
│   │   ├── middleware/      # Auth, upload, validation, errors
│   │   ├── models/          # Mongoose schemas
│   │   ├── routes/          # Express routers
│   │   ├── services/        # Email, etc.
│   │   ├── socket/          # Socket.IO + WebRTC signaling
│   │   ├── utils/           # Tokens, logger, errors
│   │   ├── validation/      # Zod schemas
│   │   ├── app.ts
│   │   └── server.ts
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/      # UI, chat, settings, call
│   │   ├── hooks/
│   │   ├── pages/
│   │   ├── services/        # API + socket client
│   │   ├── store/           # Zustand
│   │   ├── types/
│   │   └── utils/
│   ├── Dockerfile
│   └── package.json
├── scripts/
│   ├── setup-env.js
│   └── start-dev.js         # Dev + Cloudflare (cloudflared) orchestrator
├── uploads/
├── docker-compose.yml
└── package.json
```

### MongoDB collections
- **users** — profiles, settings, starred messages  
- **sessions** — refresh token hashes, devices  
- **conversations** — direct + group, participant prefs  
- **messages** — content, attachments, reactions, receipts  
- **attachments** — uploaded files metadata  
- **notifications** — in-app notifications  

---

## API overview

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/refresh` | Refresh tokens |
| POST | `/api/auth/logout` | Logout current session |
| POST | `/api/auth/logout-everywhere` | Revoke all sessions |
| POST | `/api/auth/forgot-password` | Request reset |
| POST | `/api/auth/reset-password` | Reset password |
| GET | `/api/conversations` | List chats |
| POST | `/api/conversations/direct` | Start DM |
| POST | `/api/conversations/group` | Create group |
| GET | `/api/messages/conversation/:id` | Paginated messages |
| POST | `/api/messages/conversation/:id` | Send message (+ files) |
| POST | `/api/uploads` | Upload media |
| GET | `/api/health` | Health check |

Socket.IO path: `/socket.io` — authenticate with `{ auth: { token: accessToken } }`.

---

## Production build

```bash
# Build both packages
npm run build

# Run API (serves API only; put frontend behind nginx/CDN)
npm start

# Full stack with Docker
docker compose up --build
```

For production Docker, set secrets via environment:

```bash
export JWT_ACCESS_SECRET=...
export JWT_REFRESH_SECRET=...
export CLIENT_URL=https://your.domain
export VITE_API_URL=https://api.your.domain
docker compose up --build -d
```

---

## Security

- Helmet, CORS, rate limiting  
- Mongo sanitize, XSS clean, HPP  
- HTTP-only cookies + Bearer JWT  
- bcrypt (cost 12)  
- Zod input validation  
- Secure cookies when `COOKIE_SECURE=true`  

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run setup` | Install + generate env files |
| `npm run dev` | Backend + frontend + Cloudflare tunnel |
| `npm run dev:local` | Backend + frontend only |
| `npm run build` | Production build |
| `npm run docker:up` | Start compose stack |
| `npm run lint` | ESLint |

---

## Troubleshooting

**MongoDB connection failed**  
Start Docker Mongo or set a valid Atlas `MONGODB_URI`.

**Socket.IO fails over the tunnel**  
Use `npm run dev` so a single Cloudflare tunnel hits Vite (which proxies WebSockets). Do not open the API port alone unless `VITE_API_URL` points at that public origin.

**Named Cloudflare tunnel**  
Create a tunnel in Zero Trust → get a token, then:

```bash
export TUNNEL_TOKEN=eyJ...
export PULSE_PUBLIC_URL=https://pulse.yourdomain.com
npm run dev
```

**Email not sending**  
Without SMTP, verification/reset links are printed in the **backend console**.

---

## License

MIT
