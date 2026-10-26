# PostBro — Technical Architecture (proposed implementation design)

**Status:** Design guidance / not runtime evidence. **Authority:** `PRD.md`. Validate API and product decisions before implementing them. Last prepared: 2026-10-21.

## Product boundary

PostBro is ONE Threads-only TypeScript application for **engagement automation**. It connects directly to the official Meta Threads API for engagement. Postiz exclusively owns posting and scheduling; PostBro has no Postiz runtime dependency. The Persona Engine and Reply Decision Engine remain separate components consumed by PostBro. User operates it primarily through the PostBro Telegram bot plus a narrow HTTPS Meta OAuth flow. Hermes is an independent development agent, NOT the PostBro application backend or required runtime LLM.

### Context diagram

~~~text
Owner (PostBro Telegram bot) -> Telegram adapter -> Fastify application/API
                                               -> auth + account/permission gate
                                               -> persona + KB resolver
                                               -> engagement proposal/approval service
                                               -> engagement, discovery, insights services
                                               -> durable jobs / worker (same image; separate process allowed)
                                                      |-> Meta Threads API (official)
                                                      |-> Supabase Postgres + Storage
                                                      |-> configurable hosted LLM
Meta OAuth browser -> HTTPS callback -> auth/account service -> encrypted token persistence

Developer (separate Hermes Telegram bot) -> Hermes on Contabo VPS -> repository/commands
Developer bot != Product bot; Hermes state != PostBro business state.
~~~

## Operational building blocks

| Component | Role | P0/P1 dependency |
|---|---|---|
| Fastify API | health, signed OAuth starts/callback, minimal inbound web routes, server-side authorization | P0 |
| Telegram adapter | operator allowlist, commands, inline callbacks, prompt/preview lifecycle | P0/P1 |
| Auth/account | state nonce, token refresh, immutable provider ID, capability snapshots, disconnect | P0 |
| Persona resolver | account -> approved persona/version + task surface (post vs reply) | P0 |
| Knowledge base | account-scoped reference material; suggested module, not an extra server/DB | Deferred until task specification |
| Engagement proposal + approval | durable lifecycle; idempotent callbacks; reapproval after edits | P1 |
| Inbound engagement | sync own-post replies; risk classification and persona-grounded proposal; send after approval | P1 |
| Insights | capability-aware own-post/account metrics | P1C |
| Learning | observation -> candidate -> eval -> human approval -> version activation | P2A |
| Discovery / outbound | capability-gated official keyword search; external-root replies HOLD | P2B / HOLD |

## Code module boundary proposal (no files implemented yet)

~~~text
src/
  app/                 # Fastify composition, configuration and health
  modules/
    operators/
    auth/
    accounts/
    personas/
    knowledge-base/   # only when prioritized
    approvals/
    engagement/
    discovery/
    insights/
    learning/
  integrations/
    telegram/
    threads/
    supabase/
    llm/
  workers/             # durable jobs; explicit ownership of retries
  shared/              # types, errors, config validation, observability
tests/
db/migrations/
docker/
~~~

This is a target structure. Create folders as a task requires; do not generate empty features merely to match the tree. Prefer ports/adapters: service logic should not depend on Telegram payload shapes, a specific LLM, or a live Meta connection.

## Source of truth / safety

- PRD: intended product behaviour. Supabase: accounts, persona bindings, engagement proposals, approvals, engagement job intent, attempts and audit. Meta Threads: whether post/reply actually exists. Telegram: control surface, NOT durable state. LLM: suggestions only; deterministic code authorizes execution.
- Timestamps persisted UTC; display Asia/Kuala_Lumpur unless operator configured otherwise. Do not assume VPS timezone matches display timezone.
- Scoped to immutable provider account ID at every data-access path, job, session, cache and LLM context. No shared account history or knowledge-base fallback.
- Encrypt Meta access tokens at rest; retain only necessary scopes/expiry metadata for status. Supabase server secret never exposed to clients; service-layer account authorization remains mandatory even if backend DB role bypasses RLS.
- One durable DB job claim at a time, unique external action key, bounded retry, and explicit NEEDS_RECONCILIATION state for uncertain sends. Account-/operator-bound single-use approval callbacks.
- Persona source repositories are reference implementations; audit actual code and tests, then port with licensing review and account binding. Fix the known SEMI_AUTO auto-send contradiction before adopting an old decision engine.
- Treat third-party Threads content as untrusted, including prompt-injection attempts.
- Discovery permissions, rate limits and specific Threads endpoints must be verified through official docs + actual granted capability, not presumed from the PRD.
- No Redis, broker, local LLM GPU, Kubernetes, separate microservice or full web app for the first milestone without demonstrated need.

## Runtime / deployment proposal

One Contabo VPS; Node.js >=22 + strict TypeScript + Fastify; Docker Compose for API + worker (same app source/image is fine), hosted Supabase Postgres/Storage and hosted cloud LLM provider. Public HTTPS endpoint only for required OAuth/webhook routes; reverse proxy/TLS after stable hostname decision. Initial Telegram product bot may use long polling in development (only one mode active); migrate to verified HTTPS webhook when deployment demands it.

**Status as of 2026-10-21:** Docker/Node/Git and Hermes were tested on the VPS in a prior setup session; PostBro API/worker, production Compose, domain/TLS, PostBro Telegram bot, Supabase schema, Meta app OAuth and application LLM adapter are NOT verified as implemented. Development Hermes Kimi K3/Telegram setup does not provision these app integrations. Re-check live infrastructure before marking any box complete.

## Testing gates

- P0: reject forged OAuth state, unauthorized Telegram sender, cross-account persona/data binding; encrypted token handling; CI and reproducible migration tests.
- P1: one owned-reply event -> safe score/proposal -> explicit approval -> at most one confirmed reply; rejection means no send; engagement job survives restart; no duplicate on replay/ambiguous remote outcome.
- P1C/P2: capability-aware insights, learning candidates never self-activate, discovery feature-gated, other accounts isolated.

See `IMPLEMENTATION_PLAN.md` for sequencing and `INTEGRATIONS.md` for provider preconditions.
