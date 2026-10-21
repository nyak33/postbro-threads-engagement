# PostBro — Development and Review Workflow

**Intent:** Minimize owner mediation. ChatGPT designs/reviews changes through GitHub; Hermes implements/tests on the VPS; owner gives the business decision and review approval. GitHub is the durable handoff. This is a policy proposal, not proof branch protections/CI are configured.

## Roles and boundaries

- **Owner:** sets priorities, supplies external provider access through secure channels, approves scope changes, live sends, production operations and merges.
- **Architect/reviewer (ChatGPT):** creates/updates scoped specs and reviewable documentation PRs, audits actual GitHub diff/tests against PRD, returns PASS / CHANGES_REQUIRED / BLOCKED with concise reasons. A chatbot's review is not CI or independent security certification.
- **Developer (Hermes):** reads approved task and docs, inspects real code, reports plan, implements small branch, runs tests, records exact evidence, and requests review. May delegate bounded sub-tasks; responsible for integration.
- **GitHub:** source of truth for code, commits, issue/task references and PR review history. Telegram is for commands/status, not audit evidence.
- **Environment:** Hermes dev bot on Contabo is separate from the PostBro product bot.

## Change sequence (one task per PR)

1. Owner chooses milestone/goal. Reviewer prepares spec under `docs/tasks/` with ID, scope, acceptance, dependency and permissions. Discussion/approval is required for scope-changing edits; PRD is binding until a reviewed PRD change.
2. Hermes re-syncs approved base, verifies clean worktree and reads task + `AGENTS.md`. Reports short plan and blockers; does not silently implement other PRD modules.
3. Hermes creates `feat/PB-P0-001-short-name` or `fix/TASK-ID-short-name` from current approved `main`. Never edits main or overwrites unrelated changes.
4. Implement in small commits. Run applicable reproducible checks, capture command, exit/result, and record any skipped tests. Sensitive evidence gets redacted at source.
5. Hermes pushes to authorized feature branch and opens PR when scoped WRITE credentials exist. A PR must follow `.github/pull_request_template.md` and `HANDOFF_PROTOCOL.md`. No self merge / force push.
6. Hermes sends **POSTBRO_HANDOFF_V1** (<=20 lines, include PR link/commit). Owner forwards just the PR URL to ChatGPT; reviewer reads actual diff and acceptance evidence directly.
7. Reviewer returns **PASS** (satisfies reviewed task with evidence), **CHANGES_REQUIRED** (enumerated fixes), or **BLOCKED** (missing dependency/credentials/capability). Owner approves merge; Hermes never infers merge authority from a PASS.
8. After merge, Hermes pulls reviewed main, verifies required post-merge tests and updates task status through a reviewable change. Never mark a feature done from code existence alone.

## Git publishing prerequisites

Contabo VPS was configured with a **read-only GitHub Deploy Key** for this repository. Read permissions do not permit push/PR-from-VPS. Do NOT weaken permissions, share personal tokens or attempt automation workarounds without explicit owner authorization. Later choose appropriately scoped write access, preferably limited to this repo, with branch restrictions/reviews; test with a non-main feature branch.

**While write access is unavailable:** Hermes can develop/test in a local feature branch and provide BLOCKED handoff with changed paths, local commit SHA, exact tests and blocker `GITHUB_WRITE_ACCESS`. Do not paste full private code or credentials into Telegram. Reviewer cannot independently inspect unpushed changes; do not claim review ready.

## Required checks (when code exists)

- Formatter/lint and TypeScript strict typecheck.
- Unit tests for deterministic policy, account isolation, authorization, approval/idempotency and state transitions.
- Integration tests with mocked Meta/Telegram/Supabase; live Meta only with explicit approval and a designated tester account.
- Secrets scan / inspect git diff for credentials, .env, tokens, PII, generated artifacts, dependencies and unrelated modifications.
- Container build/smoke test only when Docker files exist.
- CI status linked on PR when workflow actually exists. **No workflow is assumed currently.** Missing scripts = NOT_RUN, not PASS.

## High-risk action gate

Owner approval is required **per operation** for any external publish/reply, prod DB change, credentials/permission edits, deletion/force history rewrites, DNS/firewall changes, unexpected major dependencies, destructive migrations and merges. Terminal approval prompts are helpful but not complete security. Command tool access does not grant business approval. Clear separation between development tests and live social actions.

## Review return format

Reviewer response should be intelligible to a non-developer: (1) STATUS PASS/CHANGES_REQUIRED/BLOCKED, (2) what materially changed, (3) actual evidence and gaps, (4) risk, (5) exact next action, with optional detailed observations attached to PR. Never make the owner compare raw diffs or relay lengthy shell logs by default.

## When work stops/restarts

If laptop is closed, VPS and gateway may continue as configured; re-check with `hermes gateway status` rather than assuming. Repo and GitHub PRs persist. Resume by PR URL or task ID; read latest main and handoff before further changes. Do not resume a stale or conflicting working tree blindly.

See `HANDOFF_PROTOCOL.md` for the mandatory output contract.
