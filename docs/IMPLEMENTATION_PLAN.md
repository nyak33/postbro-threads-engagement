# PostBro — Implementation Plan and Task Map

**Status:** Proposed task decomposition under approved `PRD.md` v0.1.0. Sequencing is binding as defined by PRD section 9 unless the owner approves a scope/priority amendment. Prepared 2026-10-21. No runtime milestone is marked complete merely because this document exists.

## First-use target

One authorized Threads tester account connects using actual official OAuth; binds to its correct persona; owner can draft/approve/schedule/publish a text post in the **PostBro product Telegram bot**; real Meta ID/permalink and durable audit are saved; inbound reply receives persona-based review and exactly one approved response. Do not conflate this with the separate functioning Hermes development bot.

## Gates / phased delivery

| Phase | Work | Exit gate / evidence | Current status |
|---|---|---|---|
| Docs foundation | Agent contract, architecture, handoff, task mapping | Approved documentation PR; does NOT mean app ready | COMPLETE — merged PR #1 |
| P0 | Scaffold + CI; migrations/account isolation; OAuth/token safety; persona binding; bot authentication | Real tester OAuth and verified account/persona authz; deterministic security tests | IN PROGRESS — scaffold/CI merged PR #2; local PostgreSQL foundation merged PR #5 (20 tests), hosted verification/OAuth/bot/persona gates outstanding |
| P1A | Draft, preview, publish and durable scheduling | One real confirmed Threads text post; schedule survives restart and no duplicate | NOT STARTED |
| P1B | Owned reply sync, risk score, persona response, Telegram approval, send/reconcile | Real owned reply -> one confirmed approved response | NOT STARTED |
| P1C | Capability-aware own-post/account insights | Real supported metrics returned, unsupported ones labelled | NOT STARTED |
| P2A | Historical evidence, learning candidate, eval and human version approval | Approved candidate improves tests; rollback verified | NOT STARTED |
| P2B | Media, permission-gated discovery, multi-account controls | Each supported API capability smoke tested; no unverified outbound/DM | NOT STARTED |

## Initial task slices

| Task ID | Dependencies | Deliverable and acceptance focus | Owner / evidence |
|---|---|---|---|
| PB-P0-001 | Foundation PR approved | TypeScript/Fastify strict scaffold, env validation without secrets, health endpoint, initial unit test and CI | Hermes PR + commands + CI result |
| PB-P0-002 | PB-P0-001; Supabase project decision | Initial SQL migrations, account-scoped models, safe DB connection and repeatable migration/authorization tests | LOCAL foundation merged PR #5; hosted NOT VERIFIED |
| PB-P0-002H | PB-P0-002 local; dedicated Supabase project exists | Migration runner hardening, one migration history, role/SSL connectivity plan and safe cloud rehearsal (NO hosted execution) | New specification `tasks/PB-P0-002H.md`; implementation requires separate reviewed PR and owner go-live approval |
| PB-P0-003 | PB-P0-002; stable HTTPS + Meta tester/app | Secure Threads OAuth, state binding, encrypted token persistence/refresh | Hermes PR + controlled tester evidence |
| PB-P0-004 | PB-P0-002; separate PostBro bot token | Product Telegram bot allowlist, inline callback authorization, approval state machine | Hermes PR + unauthorized-user tests |
| PB-P0-005 | PB-P0-002/003; persona repo audit | Persona engine adapter, immutable account binding, per-surface compiler | Hermes PR + cross-account tests |
| PB-P1A-001 | P0 gates | Text draft, preview, confirm, real publish with outcome reconciliation | Hermes PR + Meta tester permalink |
| PB-P1A-002 | PB-P1A-001 | Durable schedule worker, cancellation, retries and crash-safe uniqueness | Hermes PR + restart/idempotency evidence |
| PB-P1B-001 | P0 + persona/approval | Owned reply sync, scoring adapter, review queue | Hermes PR + mocked/live evidence |
| PB-P1B-002 | PB-P1B-001 | Confirmed reply executor, idempotency and deny action | Hermes PR + approved reply evidence |
| PB-P1C-001 | P0 + granted scopes | Basic account/post insights | Hermes PR + real metric examples with redaction |

Small changes may split these tasks after review; do not combine all tasks into one large implementation PR. Scoped specifications: `tasks/PB-P0-001.md` (merged PR #2), `tasks/PB-P0-002.md` (LOCAL foundation merged PR #5) and `tasks/PB-P0-002H.md` (HOSTED readiness, not implemented; proposal for approval). All later tasks need approved specs before implementation.

## Pre-implementation dependencies

- **Currently observed in prior operator session:** Contabo VPS with Node/npm/Git/Docker; Hermes Kimi K3 via Rootsys endpoint responded in CLI and Telegram; Hermes Telegram gateway systemd service active and manual command approval denial tested; GitHub repository cloned using read-only deploy key.
- **Verified in GitHub:** Fastify scaffold and CI merged PR #2; MIT license merged PR #3; local PostgreSQL foundation, 14 account-scoped application tables and 20 passing tests merged PR #5. Required `lint-typecheck-test` enforced. No hosted app or database migration implied.
- **Verified in connected Supabase (2026-10-23, read-only):** dedicated `postbro-core` project in Singapore, active PostgreSQL 17.11, PostBro schema/roles absent, SQL read-only preflight successful; application credentials, hosted migrations, runtime connectivity and Storage unconfigured/unverified.
- **Not proven for PostBro application:** new PostBro BotFather bot, Meta Threads app/testers/granted scopes, Supabase app secret/DB runtime URL, stable HTTPS hostname, PostBro LLM adapter credentials, running deployed app or hosted PostBro database schema.
- **GitHub Hermes workflow:** Scoped GitHub fine-grained token configured on VPS for the PostBro repository; feature-branch push was tested, and PR #2 was authored through Hermes. Main is protected with PR requirement and required CI check. Keep the token secret and do not assume direct main pushes are allowed.
- **Do not paste credentials:** `SETUP.md` lists requested key names and verification. Keys must be provisioned through protected on-VPS configuration when the corresponding approved task needs them.

## Completion criteria for every task

A scoped, reviewed PR must contain reproducible implementation, actual tests, secret/diff review, documented changes to setup/architecture/env templates where needed, explicit evidence for acceptance criteria, and a standard `POSTBRO_HANDOFF_V1` block. The user gets a simple status/next action; reviewer inspects the PR. Merging only after owner approval.

## Scope controls

- PostBro implements native posting/scheduling and engagement. No Postiz runtime requirement.
- Manual and Semi-Auto replies always need user approval. Full-Auto per-account opt-in only with risk policies, caps, cooldown, kill switch and evidence.
- First deliver a single dogfood Threads tester account; multi-account isolation design and tests are mandatory early even if full controls are P2.
- Discovery-to-content/keyword opportunities may be designed later, but API feature activation is permission-gated. External-root replies and Threads DMs HOLD until officially verified.
- Do not implement real social actions or any production mutation as part of docs-only PR.
