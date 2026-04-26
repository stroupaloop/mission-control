# AGENTS.md — Mission Control (stroupaloop fork)

## What This Repo Is

Private fork of [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control).
AI agent orchestration dashboard deployed as part of the Ender Stack (UI/Control plane).

**Read FORK.md first** — it defines the hard rules for what you can and cannot touch.

## Architecture Boundaries

```
src/app/              ← Next.js App Router (upstream-owned, DO NOT modify except layout.tsx)
src/components/       ← Shared UI components (upstream-owned)
src/lib/              ← Core logic + DB (upstream-owned, only db.ts has a fork touch-point)
src/extensions/       ← OUR CODE LIVES HERE (AMS-specific integrations)
  litellm/            ← LiteLLM cost attribution + usage rollups
  oap/                ← OAP audit ingest + approval bridge
  resolver/           ← Tool-resolver telemetry + overrides
  mcp/                ← MCP audit pipeline
  security-audit/     ← Scheduled security scans
src/plugins/          ← Plugin system (upstream-owned)
src/store/            ← Zustand stores (upstream-owned)
.data/                ← SQLite database + runtime state (gitignored)
```

### The Two-Touch-Point Rule

Only TWO upstream files may be modified:
1. `src/lib/db.ts` — to call `mountExtensions()`
2. `src/app/layout.tsx` — to render `<ClientBoot />`

Everything else goes in `src/extensions/`. If you think you need to modify upstream code, you're probably wrong — find an extension hook or ask first.

## For Coding Agents (Claude Code, Codex, Cursor)

### Before writing code:
1. Read `FORK.md` — non-negotiable fork rules
2. Read `CLAUDE.md` — stack, setup, conventions
3. Check if your change belongs in `src/extensions/` (it almost certainly does)

### Do NOT:
- Modify files outside `src/extensions/`, `src/lib/db.ts`, or `src/app/layout.tsx`
- Open PRs to `builderz-labs/mission-control` (ever)
- Push Docker images to any namespace except `ghcr.io/stroupaloop/mission-control`
- Add `Co-Authored-By` or AI attribution trailers to commits

### Testing:
```bash
pnpm test             # unit tests
pnpm typecheck        # type checking
pnpm lint             # eslint
pnpm test:all         # full suite (lint + typecheck + test + build + e2e)
```

### Commit convention:
Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`)

## Deployment Context

- **Production:** ECS Fargate behind internal ALB (Ender Stack)
- **Persistence:** SQLite on EFS (`/app/.data/`)
- **Health check:** `/api/status?action=health`
- **Image:** `ghcr.io/stroupaloop/mission-control:<tag>`
- **Terraform module:** `stroupaloop/ender-stack//terraform/modules/mission-control`
