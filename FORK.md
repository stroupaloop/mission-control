# Fork Policy — stroupaloop/mission-control

**This repo is a PRIVATE fork of [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control).**

## Hard Rules

1. **NEVER open a PR to `builderz-labs/mission-control`** from this fork. Not a single line. Not "just a typo fix." Not anything.
2. **All customizations live in `src/extensions/`.** Only two upstream files may be touched:
   - `src/lib/db.ts` — to call `mountExtensions()`
   - `src/app/layout.tsx` — to render `<ClientBoot />`
   Any change outside these paths requires explicit owner approval.
3. **Workflows in `.github/workflows/` guard with `if: github.repository == 'stroupaloop/mission-control'`** so they no-op if the file ever leaks upstream.
4. **Docker images push only to `ghcr.io/stroupaloop/mission-control`.** Never to `builderz-labs` or any public namespace.

## Why This Fork Exists

AMS Global Ventures has proprietary integrations that plug into Mission Control:
- Resolver Intelligence (tool-resolver telemetry + overrides)
- OAP (audit + approvals bridge)
- LiteLLM (cost attribution + usage)
- MCP (audit pipeline)
- Security Audit (scheduled scans)

These are business-specific and not for upstream contribution.

## Rebasing Upstream

When a new upstream release drops:
1. Fetch `upstream/main`
2. Rebase `main` (our fork's main) onto `upstream/main`
3. Resolve conflicts — should be minimal because all our code is in `src/extensions/`
4. Rebuild Docker image, re-verify panels in browser
5. Tag and push to GHCR

## Contacts

Owner: Andrew (stroupaloop)
Agent: Ender Wiggin — COS; maintains this fork on Andrew's behalf
