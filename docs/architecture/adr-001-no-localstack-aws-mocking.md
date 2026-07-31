# ADR-001 — Hand-rolled vitest mocks for AWS handlers (no LocalStack/moto)

- **Status:** Accepted (2026-06-01)
- **Deciders:** stroupaloop
- **Context issue:** [ender-stack#527](https://github.com/stroupaloop/ender-stack/issues/527)
- **Related:** [mission-control#88](https://github.com/stroupaloop/mission-control/pull/88) (the bulk-redeploy feature PR that surfaced the question)

## Context

The fork's `src/extensions/fleet/` area owns a set of handlers that drive AWS
directly via the AWS SDK v3 — ECS, ELBv2, IAM, CloudWatch Logs, and Secrets
Manager. As of this ADR, **14 test files** under
`src/extensions/fleet/__tests__/` exercise AWS-touching code (400+ cases).

Every one of them uses the same approach: **hand-rolled vitest mocks**. The
SDK module is replaced with `vi.mock('@aws-sdk/client-ecs', …)`, command
constructors wrap their input in a tagged object (`{ __type, input }`), and a
single `sendMock` records every call. Tests then introspect
`sendMock.mock.calls` to assert the exact command sequence and parameters.

`mission-control#88` (bulk-redeploy) raised a fair question: these mocks catch
handler-logic bugs, but they never exercise the *real*
`ListServices → DescribeServices → UpdateService` API contract against an
AWS-compatible mock. Should the fork adopt **LocalStack** (or **moto**) as a
dev/CI dependency to close that gap?

This is a repo-wide test-infra decision, not a per-PR concern: adopting
LocalStack adds a CI container, a new dependency-drift surface, and a precedent
that every AWS-touching handler becomes a LocalStack-test candidate. So we make
the call once, here.

## Decision

**Keep the hand-rolled vitest mocks. Do not adopt LocalStack or moto.**

## Rationale

1. **ECS/ELBv2 fidelity is poor for what these handlers actually do.** The
   handlers depend on ECS service lifecycle (tags, deployments, steady-state),
   ELBv2 target groups + listener rules, and IAM role create/attach. Faithful
   ECS/ELBv2 emulation is largely LocalStack-Pro territory and only partial in
   moto. A mock that *approximates* these APIs gives false confidence and
   carries a real version-drift maintenance cost.

2. **The hand-rolled mocks already assert more than LocalStack could.** The
   security-critical contract in these handlers is an exact-parameter allowlist
   — e.g. `redeploy.ts` must send **only** `forceNewDeployment: true` on
   `UpdateService`, because IAM can't restrict `UpdateService` parameters and
   the handler is the sole boundary. The tests enforce this with
   `expect(Object.keys(input).sort()).toEqual(…)`
   (`redeploy.test.ts:118`, `bulk-redeploy.test.ts:180`). A real AWS-compatible
   backend would silently *accept* extra parameters — it cannot assert their
   absence. For this codebase, the mock is the stronger oracle.

3. **The one prod-relevant class LocalStack might catch is already covered
   elsewhere.** The bug class that integration tests against a real-ish AWS
   would catch — missing IAM permissions — is owned in two other places: the
   IAM grants live in ender-stack, and `scripts/check-iam-coverage.mjs`
   cross-checks the handlers' SDK calls against the granted action set.
   LocalStack does not enforce IAM by default, so it would not catch this class
   anyway.

4. **Cost and precedent are not justified at this scope.** CI is a single,
   container-free `quality-gate` job. LocalStack adds container boot time, a new
   dependency to keep current, and a precedent obliging the same treatment for
   all 14 AWS-touching test files. The marginal coverage does not warrant it.

## Consequences

- **Accepted gap:** no test exercises the real AWS API contract — request/
  response shapes, pagination tokens, `DescribeServices` 10-ARN chunk limits,
  and error-name semantics are encoded in the mocks by hand and can drift from
  real AWS. This risk is mitigated by (a) the SDK's own typed clients catching
  shape errors at compile time, (b) exact command-sequence + parameter
  assertions, and (c) the discipline of validating real instances in dev before
  declaring a change done.
- **Convention:** new AWS-handler tests follow the existing pattern. The
  canonical exemplar is `src/extensions/fleet/__tests__/redeploy.test.ts`.
- No new CI service, no new dev dependency.

## Alternatives considered

- **moto** — same ECS/ELBv2 fidelity gap as LocalStack Community; no advantage
  for this handler set.
- **LocalStack Pro** — better ECS support, but a paid dependency that still
  drifts from real AWS and still can't assert parameter *absence*.
- **Integration tests against a real sandbox AWS account** — highest fidelity,
  but slow, flaky, billable, and requires credentials in CI. Out of proportion
  to the risk.

## Revisit if

- A fleet handler begins to depend on AWS-*side* state transitions or
  eventual-consistency semantics that call-sequence/parameter assertions cannot
  express, **or**
- LocalStack Community gains first-class ECS + ELBv2 support that faithfully
  models the service lifecycle these handlers drive.
