# Pulse Play

In-chat social games for Pulse. Phase 1 ships an extensible **server-authoritative** game platform with four launch titles.

## Product principles

- Games are **optional** and never block messaging.
- Invitations appear as **interactive message cards** (`type: "game"`, `gameId` reference).
- **Authoritative state lives only on the Game document** — messages do not store board/score truth.
- Game moves, timers, scores, and winners are **server-managed** and **not end-to-end encrypted**. The UI states this clearly. Chat E2E for normal messages is unchanged.

## Phase 1 games

| Type id         | Players | Style                          |
|-----------------|---------|--------------------------------|
| `tic_tac_toe`   | 2       | Turn-based board               |
| `connect_four`  | 2       | Turn-based board               |
| `trivia_duel`   | 2–8     | Timed MCQ, server question bank |
| `emoji_guess`   | 2–12    | Timed emoji riddles            |

## Architecture

```
frontend (React)
  PlayPicker → POST /api/games/conversation/:id
  GameCard   → GET/POST join|action|rematch
  socket     ← game:created|updated|started|completed|expired

backend
  games/engines/*     pure rules (no Express/React)
  games/registry.ts   plugin map
  services/game/*     authz, persistence, broadcast, stats
  models/Game.ts      authoritative state
  models/GameStats.ts wins/losses/streaks + achievement hooks
```

### Engine contract

Each game implements `GameEngine` (`backend/src/games/types.ts`):

- `createInitialState` / `onJoin` / `canStart` / `start`
- `applyAction` — validates turn, move, expiry; returns new state + scores + completion
- `sanitizeStateForClient` — strips secrets (e.g. trivia correct answers) until revealed

Controllers **must not** contain win/score logic.

### Security

- Every action checks conversation membership + joined player status.
- Client-provided boards, scores, winners, timestamps, and correctness are **ignored**.
- Idempotency via `clientActionId` (stored on Game).
- Optimistic concurrency via `expectedVersion` → `409 VERSION_CONFLICT`.
- Rate limits on create/join/action (HTTP + socket).
- Trivia/emoji content is **server-curated only** (no user-supplied questions).
- Events broadcast only to `conversation:{id}` room.

### Data model (Game)

| Field | Notes |
|-------|--------|
| `conversation` | Chat thread |
| `gameType` | Engine id |
| `status` | invited \| active \| completed \| declined \| cancelled \| expired |
| `players[]` | user, join status, score, order, symbol |
| `state` | Opaque engine state |
| `currentTurnUser` | null for simultaneous games |
| `winnerIds` / `isDraw` | Server-set only |
| `version` | Monotonic |
| `processedActionIds` | Idempotency |
| `rematchOf` | Optional link |
| `expiresAt` | Invite + idle expiry |

### REST (all authenticated)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/games/catalog` | List engines |
| POST | `/api/games/conversation/:conversationId` | Create invite |
| GET | `/api/games/conversation/:conversationId` | History |
| GET | `/api/games/conversation/:conversationId/leaderboard` | Rankings |
| GET | `/api/games/:id` | Get game (sanitized for viewer) |
| POST | `/api/games/:id/join` | Join |
| POST | `/api/games/:id/decline` | Decline |
| POST | `/api/games/:id/cancel` | Creator cancel |
| POST | `/api/games/:id/start` | Creator start (multi-player) |
| POST | `/api/games/:id/action` | Move / answer |
| POST | `/api/games/:id/rematch` | Rematch invite |
| GET | `/api/games/stats/me` | Player stats |

### Socket.IO

| Event | Direction | Payload |
|-------|-----------|---------|
| `game:created` | server → room | `{ game }` |
| `game:updated` | server → room | `{ game }` |
| `game:started` | server → room | `{ game }` |
| `game:completed` | server → room | `{ game }` |
| `game:expired` | server → room | `{ game }` |
| `game:action` | client → server | optional shortcut (REST preferred) |

## Backward compatibility

- New collections: `games`, `gamestats`.
- `Message.type` enum adds `game`; optional `gameId`.
- Existing messages/conversations unchanged; clients that ignore `game` still show content text.

## Adding a new game (Phase 2+)

1. Implement `GameEngine` in `backend/src/games/engines/yourGame.ts`.
2. Register in `backend/src/games/registry.ts`.
3. Add type id to Zod enum + Mongoose enum.
4. Add a React board under `frontend/src/components/chat/play/boards/`.
5. Wire the board in `GameCard.tsx`.
6. Add engine unit tests in `scripts/test-game-engines.ts`.
7. Prefer generic names that avoid third-party trademarks (e.g. “card shedding game”, “block puzzle score battle”).

## Background maintenance

An in-process scheduler (`gameScheduler.ts`) starts with the API and every ~7s:

1. Advances timed trivia/emoji rounds past `endsAt` / `revealEndsAt` (no client required)
2. Expires abandoned invites/games
3. Retries recoverable stats leases

Disable with `GAME_SCHEDULER=0`. The HTTP `/api/games/internal/expire` route requires `CRON_SECRET` (not a public user trigger).

## Stats recovery (exactly-once)

- **Lease:** `statsRecordingAt` claimed while recording; abandoned after 2 minutes if the process dies so another sweep can reclaim.
- **Atomic counters:** each `GameStats` rollup stores `appliedGameIds`. `$inc` and `$addToSet appliedGameIds` run in **one** `updateOne`, so a crash cannot apply the counter without the claim (or the reverse).
- **Ledger:** `GameStatEvent` unique `(game, user, scope)` is written **after** the counter claim (audit + legacy guard). If an older build wrote the ledger first and died before `$inc`, recovery will not double-count (legacy under-count is not healed).
- **Success:** `statsRecorded: true` + clear lease. **Failure:** clear lease only so retries work.

## Tests

```bash
npx tsx scripts/test-game-engines.ts   # engine unit tests
npm run test:games                     # same
npm run test:game-hardening            # scheduler tick + stats lease (memory Mongo)
npm run test:pulse-play                # API smoke (API + alice/bob)
```

## Intentionally deferred (Phase 2)

- Chess, Ludo, card shedding, block-puzzle battles, drawing, realtime arcade
- XP / seasons / tournaments / ranked matchmaking
- Spectator mode, replays, custom question packs
- E2E encryption of game traffic (would need shared secrets outside server authority — conflicts with fair adjudication)
