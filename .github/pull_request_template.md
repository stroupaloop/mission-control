<!--
⚠️  FORK POLICY — READ BEFORE OPENING THIS PR

This is a PRIVATE FORK of builderz-labs/mission-control.
- This PR must target `stroupaloop/mission-control/main` ONLY.
- NEVER open a PR from this fork to `builderz-labs/mission-control`.
- All custom code must live in `src/extensions/`.
- See FORK.md for full rules.
-->

## Summary

<!-- What does this change do? One-paragraph TL;DR. -->

## Scope

- [ ] All code changes live in `src/extensions/` (except allowed upstream touch-points: `src/lib/db.ts`, `src/app/layout.tsx`)
- [ ] No files added to `.github/workflows/` that could run on upstream (guard with `if: github.repository == 'stroupaloop/mission-control'`)
- [ ] Typecheck passes (`pnpm typecheck`)
- [ ] Tests pass (`pnpm exec vitest run`)
- [ ] If UI changed: browser-verified locally with screenshot attached

## Fork-separation confirmation

- [ ] This PR targets `stroupaloop/mission-control/main` — NOT `builderz-labs/mission-control`
- [ ] No secrets, internal endpoints, or proprietary data in commit messages / code comments / PR description

## Deployment notes

<!-- Anything special about rolling this out? Migration steps? Env vars? -->
