# Pulse architecture

Pulse is a monorepo (`frontend` + `backend`) for realtime messaging and calls. This document describes the intentional layout for senior-maintainable evolution **without** changing product behaviour.

## Principles

1. **HTTP controllers stay thin** — validation + orchestration; domain rules live in services.
2. **Realtime handlers are modular** — presence, messaging, and call signaling are separate files.
3. **DTOs are explicit** — `formatMessage` / `formatConversation` own public API shapes.
4. **Frontend is feature-oriented** — `features/*` for product domains, `shared/*` for cross-cutting code.
5. **Compatibility barrels** — legacy import paths under `services/`, `utils/`, `types/` re-export new locations.

## Backend layout

```
backend/src/
  app.ts / server.ts       # bootstrap
  config/                  # env + database
  controllers/             # Express route handlers (thin)
  routes/                  # route tables + middleware wiring
  middleware/              # auth, validate, upload, errors
  models/                  # Mongoose schemas
  services/
    conversation/          # access + format DTOs
    message/               # access + populate paths
    email.service.ts
  socket/
    index.ts               # IO bootstrap + connection lifecycle
    presence.ts            # online maps, grace period, sweeper
    membership.ts          # conversation membership cache
    rateLimit.ts
    handlers/
      messaging.handlers.ts
      call.handlers.ts
  validation/              # Zod schemas
  utils/                   # pure helpers (tokens, media, errors)
```

### Key flows

| Concern | Entry | Domain |
|--------|--------|--------|
| REST conversations | `conversation.controller` | `services/conversation/*` |
| REST messages | `message.controller` | `services/message/*` + `utils/messageFormat` |
| Presence | `socket/presence` | DB `isOnline` + contact fan-out |
| Calls | `socket/handlers/call.handlers` | shared-direct-chat authorization |

## Frontend layout

```
frontend/src/
  app/                     # (reserved) app shell composition
  features/
    chat/
      services/            # conversation / message / user / notification / upload
      components/message/  # message-scoped UI pieces
    auth/ call/ settings/  # feature homes (growing)
  shared/
    api/                   # axios client, envelope types, extractData
    types/                 # domain TypeScript models
    lib/                   # cn, format, pure helpers
    ui/                    # EmptyState, MenuItem, …
  components/              # existing screens (stable paths)
  pages/ store/ hooks/     # existing entry surfaces
  services/ utils/ types/  # re-export shims for older imports
```

### Service naming

| Prefer (new code) | Compatibility facade |
|-------------------|----------------------|
| `conversationService.list` | `chatService.getConversations` |
| `messageService.send` | `chatService.sendMessage` |
| `userService.search` | `chatService.searchUsers` |

Import new modules with the `@/` alias (`@/shared/...`, `@/features/...`).

## Typing conventions

- API responses use `{ success, data }` — parse with `extractData<T>()`.
- Prefer named domain types (`Message`, `Conversation`, `SenderIdentity`) over `any`.
- Backend formatters return plain objects suitable for JSON (signed media URLs applied once).

## Non-goals (for this refactor)

- No API route or payload renames.
- No DB schema migrations.
- No UX redesign.

## How to extend

1. **New REST endpoint** — Zod schema → thin controller method → service function → DTO formatter if needed.
2. **New socket event** — register in the appropriate `handlers/*` file; keep auth checks next to the handler.
3. **New UI surface** — place under `features/<domain>/components`; pull primitives from `shared/ui`.
