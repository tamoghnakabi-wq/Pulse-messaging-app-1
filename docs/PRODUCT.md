# Pulse product focus

Pulse is a capable general messenger. To stay memorable, pick **one sharp promise** and let features support it.

## Recommended promise (v1)

**Private messaging that works** — calm UI, honest encryption, sessions you control, and chat that stays fast after refresh.

### What that means in product terms

- Default to **E2E for text**; label media/calls honestly until they match.
- Make **open chat → send → decrypt → scroll** the best loop in the app.
- Surface **sessions, safety numbers, block/report** without burying them.
- Resist Discord-scale feature sprawl until chat feels unmistakable.

### Alternate promises (only if you commit fully)

| Promise | Requires |
|---------|----------|
| Exceptionally good calls | TURN/SFU, quality metrics, not only Socket relay |
| Small-team ops hub | Threads, roles, search, integrations |
| Network-resilient messenger | Market relay/tunnel strength as a feature |

## Near-term engineering (not more features)

1. Chat polish: open speed, empty states, send reliability
2. CI: typecheck, lint, build, smoke (`docs/OPS.md`)
3. Ops: Redis + TURN + malware scan for real multi-user load

Feature breadth without a promise reads as “best-of WhatsApp/Telegram/Discord.” Focus first.
