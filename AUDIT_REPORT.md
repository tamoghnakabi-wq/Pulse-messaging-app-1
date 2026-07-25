# Pulse — Production Readiness Audit

**Date:** 2026-07-25 · **Branch:** `main` @ `317fb62` · **Scope:** `/Users/tamoghnakabi/pulse`
**Baseline:** typecheck ✅ · lint ✅ (14 pre-existing warnings) · build ✅ · all test suites ✅

> **Pass 2 (same day)** — after the review below, a second pass acted on the
> highest-value recommendations: horizontal scaling, observability and an
> automated test suite. **Score raised 78 → 88.** See
> [§8 Pass 2](#8-pass-2--acting-on-the-recommendations) for what changed and how
> it was verified. Sections 1–7 describe the original review and remain accurate
> except where §8 marks an item resolved.

> The primary working directory (`studioproject`) holds an unrelated Java/Maven project, a
> Tauri PDF app and `astraeus`. The audit brief (realtime messaging, WebRTC, E2E encryption,
> media uploads, notifications) describes **Pulse** only, so Pulse is what was audited.

---

## 1. Coverage — what was actually examined

Read in full: `app.ts`, `server.ts`, `config/`, all middleware, `socket/` (hub, presence,
membership, rate limiting, messaging + call handlers), `models/` (User, Message, Conversation,
Session, Notification), `controllers/` (auth, message, conversation, user), call registries,
`utils/` (tokens, mediaSign, mediaUrl, ttlCache, logger, privacy), auth routes + validation
schemas, Dockerfile, docker-compose, CI workflow. Frontend: `socket.ts`, `shared/api/client.ts`,
`useSocketEvents.ts`, `chatStore.ts`, `useMobileViewport.ts`, `E2EMediaAttachment.tsx`,
`sessionCleanup.ts`, plus targeted reads of `webrtc.ts` (teardown paths) and `callStore.ts`.

Swept mechanically across the whole tree: listener add/remove balance, `createObjectURL` /
`revokeObjectURL` balance, timer creation vs. clearing, cache-invalidation call sites,
`toPublicJSON` leakage, tracked secrets.

**Not read line-by-line:** `games/` engines and `game.service.ts` (~1500 lines), `services/e2e.ts`
(1546 lines), the bulk of `webrtc.ts` (3092 lines), and most presentational components
(`MessageBubble`, `ChatWindow`, `SettingsModal`, `Sidebar`). These carry dedicated passing test
suites (game engines, hardening, crypto) and were not implicated by the mechanical sweeps.
Findings below are what I verified, not an exhaustive enumeration of everything in 33k lines.

---

## 2. Issues found and fixed (22)

### Memory & resource leaks

| # | Issue | File |
|---|---|---|
| 1 | **Socket rate-limiter buckets never freed.** `hits` Map keyed by socket id, never swept. Socket ids are never reused → one permanent entry per connection, per limiter, for process lifetime. | `socket/rateLimit.ts` |
| 2 | **`typingUsers` grew unboundedly.** Inner user entry was deleted but the per-conversation `Map` was left behind empty — one leaked Map per conversation ever typed in. Three sites (typing:stop, the 3s timeout, disconnect). | `socket/presence.ts`, `socket/handlers/messaging.handlers.ts`, `socket/index.ts` |
| 3 | **Decrypted media blobs never released.** Module-level `decryptCache` held `URL.createObjectURL` handles forever, explicitly "not revoked". Every image/video scrolled past pinned its Blob for the tab's life — hundreds of MB in a media-heavy chat, and a likely mobile-Safari OOM. Now a 60-entry LRU that revokes on eviction, plus full clear on logout (plaintext must not outlive the session). | `components/chat/E2EMediaAttachment.tsx`, `utils/sessionCleanup.ts` |
| 4 | **`orientationchange` listener could never be removed** — registered as an inline arrow, absent from the cleanup function. Deferred settle timers were also untracked. | `hooks/useMobileViewport.ts` |
| 5 | **A new `AudioContext` per notification sound.** `ctx.close()` ran in `onended`, which does not fire when autoplay policy suspends the context. Browsers cap concurrent contexts (~6); past that, construction throws and notification sounds silently die for the session. Now one shared context; only nodes are released. | `hooks/useSocketEvents.ts` |
| 6 | **Replaced avatars / covers / group avatars orphaned on disk forever.** Every profile-photo change leaked a file. Added `deleteStoredUpload()`, path-confined to `config.uploadDir` so a tampered DB value cannot become an arbitrary-file delete. | `utils/mediaUrl.ts`, `controllers/user.controller.ts`, `controllers/conversation.controller.ts` |

### Concurrency & correctness

| # | Issue | File |
|---|---|---|
| 7 | **View-once photos leaked to concurrent opens.** Read-then-write: the handler loaded the message, checked `viewOnceViewedBy`, then pushed and saved. N parallel requests all passed the check and *all* received the media — defeating the guarantee outright. Now an atomic conditional `$addToSet` claim; losers get the locked shape. **Verified: 1/5 concurrent opens receive media (was 5/5).** | `controllers/message.controller.ts` |
| 8 | **Keyset pagination dropped messages.** Sort key is `(createdAt, _id)` but the cursor compared `createdAt` alone, so every message sharing the cursor's millisecond was skipped — routine under bursts. Now a proper compound cursor. **Verified: 15/15 messages reachable, zero duplicates, across concurrent same-ms sends.** | `controllers/message.controller.ts` |
| 9 | **`markRead` clobbered other participants' unread counts.** A full `conv.save()` rewrites the whole `participants` array, so a concurrent `sendMessage` `$inc` on a *different* participant was lost. Now a positional `$set` touching only the caller's subdocument. | `controllers/conversation.controller.ts` |
| 10 | **`starMessage` lost concurrent updates** — read array, mutate, save whole doc. Now atomic `$pull` / `$push` with `$slice: -500` for the cap. | `controllers/message.controller.ts` |

### Messaging reliability

| # | Issue | File |
|---|---|---|
| 11 | **Forwarded messages arrived with no unread badge.** `forwardMessage` only set `lastMessage`; it skipped the `$inc unreadCount` and the `$unset deletedForMeAt` that `sendMessage` performs. **Verified: unread now +1.** | `controllers/message.controller.ts` |
| 12 | **Forwarded messages were silent.** No `notification:message` emit → no toast, sound, or badge for recipients without the chat open. | same |
| 13 | **Blocks were bypassable via forward.** `sendMessage` enforces `isEitherBlocked`; `forwardMessage` did not. Blocked direct targets are now skipped. | same |
| 14 | **Notification insert failures were swallowed** (`.catch(() => undefined)`), hiding a whole class of "notifications stopped working" bugs. Now logged with context. | same |

### Security

| # | Issue | File |
|---|---|---|
| 15 | **2FA challenges had unlimited guesses.** A challenge stayed valid for its full 5 minutes with no attempt counter — only the IP rate limit bounded guessing. Now burned after 5 wrong codes, with the count recorded in the security event. | `controllers/auth.controller.ts` |
| 16 | **`POST /auth/login/2fa` had no request validation** — the only auth route without a Zod schema. Added `login2FASchema`. | `validation/auth.schema.ts`, `routes/auth.routes.ts` |

### Stability

| # | Issue | File |
|---|---|---|
| 17 | **No `unhandledRejection` / `uncaughtException` handlers.** On Node 20 an unhandled rejection terminates the process — every connected socket dropped, no log line explaining why. Rejections are now logged and survived; uncaught exceptions log and exit cleanly for the supervisor. | `server.ts` |
| 18 | **No `keepAliveTimeout` / `headersTimeout`.** Node's 5s default below a proxy's idle timeout causes the classic intermittent-502 race. Set to 65s/70s. | `server.ts` |
| 19 | **Shutdown was not idempotent** and its 10s force-exit timer held the event loop open. | `server.ts` |

### Performance

| # | Issue | File |
|---|---|---|
| 20 | **A `User.findById` per read receipt**, behind a per-call dynamic `import()`, on a path rate-limited to 15/s/socket. Now a static import plus a 30s TTL cache of the `readReceipts` flag. | `socket/handlers/messaging.handlers.ts` |
| 21 | **`message:delivered` was the one unlimited socket handler** — a DB write plus a room broadcast, spammable without bound. Added a 20/s limiter matching its siblings. | same |
| 22 | **Every ICE candidate logged at `info`,** with a room-size lookup on the signaling hot path; per-call PCM stats logged every 5s per socket in production. Both moved behind a dev check. Call milestones still log at `info`. | `socket/handlers/call.handlers.ts` |

### Maintainability

**Two functions named `userInConversation` with opposite parameter orders**, both `(string, string)` —
`socket/membership.ts` takes `(userId, conversationId)`, the service took `(conversationId, userId)`.
Both call sites happened to be correct, but TypeScript could never catch a swap in an
authorization check. The service function is now `conversationHasUser(conversationId, userId)`.

---

## 3. Verification

```
typecheck   ✅ backend + frontend
lint        ✅ 0 errors (14 pre-existing warnings, untouched)
build       ✅ backend tsc + frontend vite
test:e2e-media          ✅   test:games         ✅
test:game-hardening     ✅   test:malware       ✅
full-smoke-test         ✅ 36/36 (live API + Mongo 7 + sockets)
e2e-media-integration   ✅ 9/9
pulse-play smoke        ✅ all
targeted fix harness    ✅ 5/5  (view-once race, tie-timestamp paging, forward unread)
```

Run against a disposable `mongo:7` container with a real API process; no errors or unhandled
rejections in the server log. Environment torn down afterwards.

---

## 4. Remaining recommendations (not changed)

### Blocking for horizontal scale

1. **The server is architecturally single-instance.** Presence (`onlineUsers`, `lastHeartbeat`),
   typing state, both call registries, the 2FA challenge map and all TTL caches are in-process
   `Map`s, and there is **no Socket.IO Redis/cluster adapter**. Running two replicas silently
   breaks presence, typing, room fan-out and call signaling. Fix: `@socket.io/redis-adapter` +
   move presence/call registries to Redis. This is the single highest-value change.

2. **Call media is relayed through Node as base64.** Despite WebRTC signaling being present,
   `call:media` fans out base64 PCM/JPEG frames through the Express process at up to 180 msg/s
   per socket, ≤128 KB each, with group calls fanning out to every peer. This is an SFU written
   in JavaScript on the API's event loop. It will dominate CPU long before messaging does.
   Fix: complete the P2P WebRTC path, or move media to a real SFU (mediasoup / LiveKit).

3. **`sweepPresence` runs `User.find({ isOnline: true, _id: { $nin: liveIds } })` every 15s**,
   where `liveIds` is every online user. At 10k concurrent that is a 10k-element `$nin` four
   times a minute. Replace with a per-user TTL key in Redis.

### Security

4. **Signed media URLs are bearer tokens, not user-scoped.** `signUploadPath` HMACs
   `path:exp` only, so a 2h URL works for anyone who obtains it. This is the standard presigned-URL
   tradeoff, but consider binding the signature to a user id for private media.
5. **Refresh tokens live in `localStorage`** (already noted in `SECURITY_REPORT.md`) — XSS-readable.
   `httpOnly` cookie + CSRF token is the stronger design.
6. **`identityPublicKey` can be silently replaced** by any authenticated session, so a compromised
   session can substitute an E2E key. Add safety-number verification / key-change warnings.
7. **Decrypted conversation previews are cached in `localStorage`** (`pulse_cached_conversations`),
   which weakens the E2E story on shared devices. `sessionStorage` or encryption at rest.
8. **MongoDB runs without `--auth`** in compose (mitigated: internal network, no host ports).
9. **`npm install` (not `ci`) in the Dockerfile** → non-reproducible images. No `HEALTHCHECK`.

### Correctness / performance

10. **`createDirect` has a TOCTOU race** — two users opening a chat with each other simultaneously
    create two conversations. Needs a unique index on the normalized participant pair.
11. **`listConversations` filters in memory** after a 200-row `lastMessageAt` fetch, so a user with
    >200 chats can have archived/pinned conversations missing from those filters.
12. **`searchMessages` and `searchUsers` use unanchored `$regex`** — collection scans that no index
    can serve. A text index exists on `Message` but is unused. Needs Atlas Search / OpenSearch, or
    accept word-prefix semantics and use the text index.
13. **`addParticipants` has no group-size cap** and does not verify the ids are real users — the
    participants array can grow toward the 16 MB document limit.
14. **`reactToMessage` still uses read-modify-write** on the reactions array; simultaneous reactions
    in a busy group can lose one. Left alone as it needs a careful rewrite of the response shape.
15. **`forwardMessage` is N+1** — up to 20 targets × 4 sequential round trips.
16. **`deleteForEveryone` clears the attachment list but never deletes the files**, so media stays
    on disk and reachable by signed URL. Needs a reaper for orphaned `Attachment` rows too.
17. **`authenticate` costs 2 DB round trips per request** (Session + full User doc). Cache the user
    for a few seconds, or store what middleware needs in the token.

### Process

18. **No unit or integration tests for the HTTP/business layer.** Coverage is smoke tests plus game
    and crypto suites; no controller, service or React component tests. Highest-value additions:
    auth flows, permission checks, message pagination.
19. **`test:malware` is in the `ci` npm script but missing from the GitHub workflow.**
20. **Logging is unstructured `console.*`** — no JSON, no levels, no sink. Add pino + a real
    aggregator before scaling.
21. **No metrics, tracing or error tracking** (Sentry/OTel). No `/metrics`.

---

## 5. Production readiness: **78 / 100**

| Dimension | Score | Notes |
|---|---:|---|
| Security | 88 | Genuinely strong: HMAC-signed media, fail-closed E2E, magic-byte + ClamAV upload checks, refresh rotation with reuse detection, per-route rate limits, privacy redaction, tight helmet/CSP. Deductions for localStorage tokens and unscoped media URLs. |
| Reliability | 80 | Idempotent sends via `clientId`, presence grace periods, reconnect/bfcache handling and call recovery are well thought through. Was missing process-level crash handling (now fixed). |
| Code quality | 82 | Consistent layering, real comments explaining *why*, disciplined TypeScript. Some read-modify-write patterns and heavy dynamic `import()` in hot paths. |
| Maintainability | 75 | Clear structure, but several 700–3000 line files and a duplicated-name API foot-gun (fixed). |
| Testing | 60 | Excellent smoke/E2E/game coverage; no unit or component tests. |
| Scalability | 55 | Single-instance by construction; media relayed through the API process. |
| Observability | 50 | Unstructured logs, no metrics, no error tracking. |

**Verdict:** ready to ship to a real user base on a single well-provisioned instance. Not ready
to scale horizontally without the Redis adapter, and not ready for call volume without moving
media off the API process.

---

## 6. Capacity estimate

| Users | Verdict | Reasoning |
|---|---|---|
| **10k registered** (~500–1500 concurrent) | ✅ **Ready today** | One 2–4 vCPU instance + managed Mongo handles this comfortably. Messaging, presence and the DB indexes are all sized for it. Caveat: concurrent *calls* cap out around 50–150 relayed audio sessions per instance — video far fewer — because media transits the Node event loop. |
| **100k registered** (~5k–15k concurrent) | ⚠️ **Needs work — ~2–4 weeks** | Requires, in order: Redis adapter + externalized presence/call state (unblocks replicas); media moved to an SFU or true P2P; `$nin` presence sweep replaced; message search moved off `$regex`; media served from object storage + CDN instead of local disk. Mongo itself is fine with the existing indexes. |
| **1M registered** (~50k–150k concurrent) | ❌ **Needs re-architecture** | Beyond the above: sharded/partitioned message storage with archival tiering, a dedicated signaling tier, real push notifications (APNs/FCM — the browser `Notification` API does not reach closed apps), object storage as the only media path, per-service autoscaling, and full observability. Realistically a multi-month effort. |

---

## 7. Files modified (20)

**Backend (15)** — `server.ts` · `controllers/{auth,message,conversation,user}.controller.ts` ·
`routes/auth.routes.ts` · `validation/auth.schema.ts` ·
`services/conversation/conversationAccess.service.ts` ·
`socket/{index,presence,rateLimit}.ts` · `socket/handlers/{messaging,call}.handlers.ts` ·
`utils/{mediaUrl,ttlCache}.ts`

**Frontend (5)** — `hooks/{useSocketEvents,useMobileViewport}.ts` ·
`components/chat/E2EMediaAttachment.tsx` · `store/chatStore.ts` · `utils/sessionCleanup.ts`

No feature was removed or redesigned; no UI was changed. Every edit is a leak fix, a race fix,
a missing-guard fix, or a log-level change.

---

## 8. Pass 2 — acting on the recommendations

Targeted the three weakest dimensions: Scalability (55), Observability (50) and Testing (60).

### 8.1 Horizontal scaling — the single-instance ceiling is gone

`backend/src/socket/cluster.ts` (new) makes multi-instance operation a config flag.
Set `REDIS_URL` and the process attaches the **Socket.IO Redis adapter** — so `io.to(room).emit`,
`fetchSockets`, `socketsJoin/Leave` and `disconnectSockets` reach every replica — plus a
**presence mirror** that keeps `isUserOnline()` synchronous (it is called per recipient on the
send path) while still seeing users attached to other instances.

The mirror is snapshot-based, not event-based: each instance republishes its full online set
under a TTL key every 5s, with an immediate debounced republish when a user's state actually
changes. A crashed instance's users expire on their own; a new instance converges without
replaying an event log. Two ordering hazards were handled: `resetPresenceOnBoot` is **skipped**
when clustered (a restarting replica must not mark its peers' users offline), and `initCluster`
runs before the server accepts connections.

Without `REDIS_URL` nothing changes — it logs `running single-instance` and behaves exactly as
before. Redis failure at boot degrades to single-instance rather than refusing to start.

**Verified** with two real instances against one Redis + one Mongo (`npm run test:cluster`, 6/6):
message delivery, per-user notifications, typing indicators, presence, and call signaling all
cross the instance boundary.

That test also surfaced a **pre-existing bug unrelated to Redis**: sockets only join conversation
rooms at connect time, so anyone already online when a new chat was created received nothing in
realtime until they reconnected or opened it. `createDirect`, `createGroup` and `addParticipants`
now join live sockets to the new room.

### 8.2 Observability — structured logs, correlation, metrics

- **`utils/logger.ts`** now emits one JSON object per line in production (`LOG_FORMAT=pretty`
  opts out), honours `LOG_LEVEL`, and stamps every line with the active request id.
- **`utils/requestContext.ts`** (new) propagates a request id through async work via
  `AsyncLocalStorage`, so a service five awaits deep logs under the right id without threading a
  parameter through every signature. Inbound `X-Request-Id` is accepted only if well-formed.
- **`middleware/observability.ts`** (new) times every response and records it by **route
  template** — `/api/messages/:id`, not one series per message id — with an overflow bucket so an
  unmatched-path flood cannot explode cardinality. 5xx logs at error, slow requests at warn.
- **`GET /api/metrics`** exposes Prometheus text: request counts/latency/errors by route, status
  classes, socket gauges, online users, memory, and log counts by level. Requires
  `METRICS_TOKEN` in production (404s without it, compared in constant time).
- **`GET /api/ready`** is a real readiness probe — 503 when Mongo is disconnected — and is now
  what the Docker and compose healthchecks use, so a container with a dead DB connection leaves
  rotation instead of serving 500s.

### 8.3 Testing — 60 integration tests where there were none

`backend/test/` boots the **real Express app** against an ephemeral MongoDB
(`mongodb-memory-server`) — no mocked models, no stubbed middleware. Run with `npm test`; wired
into CI as its own step needing no external service.

| Suite | Covers |
|---|---|
| `auth.test.ts` (16) | registration validation, enumeration resistance, lockout, forged/wrong-type tokens, refresh rotation + reuse revocation, logout, per-session revocation |
| `authorization.test.ts` (16) | outsider access to conversations/messages, edit & delete ownership, group admin/owner rules, privacy redaction |
| `messaging.test.ts` (13) | idempotent `clientId` retries, unread lifecycle, tie-timestamp pagination, view-once single-use, forward semantics, block enforcement |
| `concurrency.test.ts` (15) | simultaneous reactions, concurrent direct-chat creation, group guards, star toggling, observability endpoints |

Several are written as regressions against the specific races fixed in pass 1 — the view-once
and pagination tests fail on the previous implementations.

**The suite immediately earned its keep.** `rotates the refresh token` failed on first run:
`signRefreshToken` produced a **byte-identical token** for two calls in the same second, because
the payload was fully determined by `(userId, sessionId)` plus JWT's second-granularity
`iat`/`exp`. Rotation silently no-opped — the stored hash never changed, the "old" token stayed
valid, and reuse detection could never fire. A per-issue `jti` nonce fixes it; the field is
optional so tokens issued before the change still verify.

### 8.4 Correctness and hardening also fixed in pass 2

| Issue | Detail |
|---|---|
| **Reaction races** | `reactToMessage` was still read-modify-write; simultaneous reactions in a group lost one. Now atomic `$pull` / `$addToSet` / capped `$push`. |
| **Duplicate direct chats** | Added a unique sparse `directKey` (`smallerId:largerId`) and an upsert, so two people opening a chat with each other converge on one thread. |
| **Unbounded groups** | 256-participant cap on create and add — the participants array lives in the conversation document and was walking toward Mongo's 16 MB limit. |
| **Unverified participants** | `addParticipants` never checked ids against the users collection; groups could accumulate non-existent members. |
| **500s on malformed ids** | Conversation schemas took `z.string()`, so a bad id reached `new Types.ObjectId()` and threw a raw BSON error. Now rejected at the edge as 400. |
| **Per-request hydration** | The session lookup in `authenticate` runs on every authenticated request and never needed a Mongoose document; now `.lean()` with `updateOne` on the two invalidation paths. |

### 8.5 Infrastructure

Dockerfile uses `npm ci` when a lockfile is present (reproducible images) and gained a
`HEALTHCHECK` on `/api/ready`. Compose adds an internal-only Redis service, wires
`REDIS_URL`/`METRICS_TOKEN`/`LOG_LEVEL`, and points the backend healthcheck at readiness. All new
environment variables are documented in `backend/.env.example`.

**Correction to §4:** item 19 claimed `test:malware` was missing from CI. It was already there
(`.github/workflows/ci.yml:62`). The real gap was the absence of any HTTP-layer test suite, now
addressed.

### 8.6 Verification

```
typecheck ✅   lint ✅ 0 errors   build ✅
backend integration      ✅ 60/60   (ephemeral MongoDB)
cluster (2 instances)    ✅ 6/6     (shared Redis + Mongo)
full-smoke-test          ✅ 36/36   (single-instance, unchanged)
e2e-media-integration    ✅ 9/9     pulse-play ✅
e2e-media / games / game-hardening / malware ✅
```

Both modes were exercised: clustered (two processes, Redis) and the default single-instance path,
to confirm the scaling work is genuinely opt-in.

### 8.7 Revised scores

| Dimension | Was | Now | Why |
|---|---:|---:|---|
| Security | 88 | 90 | Refresh rotation actually rotates; malformed ids rejected at the edge |
| Reliability | 80 | 88 | New-conversation realtime gap closed; readiness probe; remaining races removed |
| Code quality | 82 | 85 | Atomic write paths throughout; no read-modify-write left on hot endpoints |
| Maintainability | 75 | 82 | Executable spec of intended behaviour; documented env surface |
| Testing | 60 | 85 | 60 integration tests + cluster harness, in CI |
| Scalability | 55 | 80 | Verified multi-instance operation; remaining ceiling is call media |
| Observability | 50 | 85 | JSON logs, request correlation, Prometheus metrics, readiness |

**Overall: 78 → 88.**

### 8.8 What still caps the score

1. **Call media still transits the API process** as base64 PCM/JPEG. The Redis adapter lets you
   add replicas, but each one still burns CPU relaying media on its event loop. Moving to an SFU
   (mediasoup / LiveKit) or completing the P2P WebRTC path is now the top scalability item.
2. **Media lives on local disk.** With multiple replicas, uploads must go to object storage +
   CDN or two instances will serve different file sets. *This is a prerequisite for actually
   running replicas.*
3. **No frontend tests** — the backend is well covered now; React components and stores are not.
4. **No error tracking or tracing** (Sentry / OpenTelemetry). Metrics and logs exist; spans do not.
5. **Message search still uses unanchored `$regex`** — needs Atlas Search or word-prefix semantics.
6. **The presence sweeper runs on every replica**, duplicating reconciliation work. Harmless
   (idempotent) but wants leader election at scale.

### 8.9 Revised capacity estimate

| Users | Verdict |
|---|---|
| **10k** | ✅ Ready. Unchanged, but now with metrics to see it and tests to protect it. |
| **100k** | ⚠️ Reduced from 2–4 weeks to roughly **1–2 weeks**: clustering, presence and observability are done and verified. Remaining blockers are object storage for media and moving call media off the API process. |
| **1M** | ❌ Still a re-architecture: sharded/tiered message storage, real push notifications (APNs/FCM), a dedicated signaling tier, full tracing. |
