# PostBro — Product Requirements Document (PRD)

**Document ID:** PB-PRD-001  
**Version:** 0.1.0 (initial specification)  
**Updated:** 2026-10-15 (Asia/Kuala_Lumpur)  
**Repository:** nyak33/postbro-threads-engagement  
**Status:** Planning / not implemented; a checked requirement must have test evidence  
**Owner:** Project maintainer  
**Authority:** This file is the source of truth for product scope, workflow, acceptance, and sequencing. Setup details live in [SETUP.md](SETUP.md); environment variable names in [../.env.example](../.env.example).

## 1. Product definition

**PostBro** is a Threads-only engagement automation backend operated primarily from Telegram. It connects directly to Meta's official Threads API for engagement on authorised accounts. Postiz exclusively owns posting and scheduling; PostBro has no Postiz runtime dependency. The Persona Engine and Reply Decision Engine remain separate components consumed by PostBro.

### 1.1 Objectives

1. **Dogfood first:** reliably manage the owner's authorised Threads test accounts before any customer rollout.
2. **Engagement-only product:** PostBro handles inbound engagement automation for owned Threads posts/replies. Postiz owns publishing and scheduling; PostBro does not implement a posting or scheduling module.
3. **Useful AI without spam:** skip irrelevant engagement; use human review by default; obey API permissions, rate limits and account-specific safety limits.
4. **Persona consistency:** learn from historical authentic posts, approved revisions and explicit feedback, while protecting each account's identity from uncontrolled drift.
5. **Low operational complexity:** Telegram first, minimal OAuth web endpoints, one VPS, hosted Supabase and a configurable cloud LLM.

### 1.2 Success criteria for first usable release

- At least one permitted Threads tester account can connect via real OAuth, disconnect/reconnect, and refresh its own token.
- From Telegram, an authorised operator can review, approve, reject or edit a proposed Threads reply; the actual Meta reply result and permalink/context are stored.
- Engagement execution jobs survive process restart and do not intentionally retry uncertain remote replies without reconciliation.
- PostBro discovers a real reply on an owned Threads post, drafts a persona-aligned response, obtains Telegram approval and sends once.
- Each connected account resolves to its own verified persona and cannot accidentally use another account's credentials/history.
- Audit trail can answer: which account, what action, who authorised it, model output, result and when.
- Basic own-post/account insights retrieved and displayed if the app's granted permissions support them.

### 1.3 Out of scope / deferred

- Instagram, Facebook Pages or any non-Threads platform.
- Any PostBro posting or scheduling module; Postiz owns those capabilities. Postiz is not a runtime dependency.
- Commercial billing, organisations/team permissions and full customer self-service onboarding.
- Large web dashboard / visual calendar (later); only a minimal secure account-connection web flow is needed.
- Threads DM read/send automation until a supported **official public API** and necessary permissions are positively verified.
- Browser scraping or unauthorised session automation to bypass API restrictions.
- Local GPU/LLM hosting, Kubernetes or independent microservices.

## 2. Decisions and terminology

### 2.1 Accepted product decisions

| Area | Decision |
|---|---|
| Platform | Threads only |
| Repository | nyak33/postbro-threads-engagement |
| Main interface | Telegram Bot API, inline keyboard + free-text instructions |
| Account connection | Own Meta Threads App ID/Secret; direct official OAuth |
| Meta mode for first use | Development Mode with eligible Threads Tester accounts |
| Backend | Node.js 22+, TypeScript, Fastify |
| Persistence | Hosted Supabase Postgres; Supabase Storage for media |
| Job execution | Durable database-backed queue + worker, initially on same VPS |
| AI | Cloud inference, configurable provider/model, not hardcoded to Hermes |
| Persona | Adapt existing PostBro Persona Engine and Decision Engine |
| Learning | Observe -> consolidate -> evaluate -> user approve -> version -> activate |
| Deployment | Docker on one always-on VPS with stable HTTPS public origin |

### 2.2 Definitions

- **Manual:** operator requests engagement proposals and explicitly approves every reply action.
- **Semi-Auto (default):** system proactively observes inbound engagement and drafts replies; operator explicitly approves every externally visible reply action.
- **Full-Auto:** system may execute only **pre-authorised, low-risk, eligible** reply actions under strict account limits; uncertain/high-risk cases still go to review. New accounts start in Semi-Auto. Full-Auto authorization policy is implemented and tested separately.
- **Source account:** connected Threads identity confirmed by the provider, keyed by immutable provider ID, not username alone.
- **Persona:** stable base profile + per-surface context overrides + approved learned guidance; separate version history.
- **Learning candidate:** evidence-backed proposed change, not an automatically active instruction.
- **Confirmed operation:** a provider response/reconciliation positively establishes the remote post/reply, not merely that an API request was attempted.
- **Trends:** keyword-search-derived topics/opportunities; do not claim platform-wide trending rankings unless Meta supplies that signal.

## 3. System architecture

### 3.1 Components

**User layer**
- Telegram Gateway: authenticated /start, menus, engagement inbox, approval keyboards, status and insights.
- Minimal HTTPS OAuth UI: starts signed account link flow; receives callback; associates Meta account with previously authenticated Telegram operator.

**PostBro backend (TypeScript / Fastify)**
- Identity/Auth: OAuth state, token exchange/refresh, capability checks and account selection.
- Account + Persona: verified bindings, onboarding, context resolution.
- Engagement: owned-post inbound polling; decision scoring; safe reply executor; outward conversation discovery only where authorised.
- Postiz boundary: PostBro stores no post drafts, publishing queue or schedule state.
- Discovery: official keyword search and opportunity filtering where permitted.
- Insights: supported post/account metrics, snapshots and digest.
- Learning: historical data importer, observation extraction, semantic grouping, reflection, eval, candidate review/versioning.
- Approval: Telegram callback handlers, edit sessions, durable state transitions and logs.
- Workers: engagement reply sync/execution, token refresh, learning and insights collection.

**External systems**
- Official Meta Threads API, Telegram Bot API, hosted Supabase (DB + media), cloud LLM.
- Stable HTTPS endpoint / reverse proxy and one always-on VPS.

### 3.2 Recommended infrastructure

- One application codebase and Docker deployment; API and worker may run in separate processes from the **same image**.
- One hosted Supabase project; initially no Redis, vector database or message broker.
- Schedule all persisted timestamps in UTC; display in Asia/Kuala_Lumpur unless operator selects otherwise.
- Backend-only Supabase secret key; encrypted Meta user tokens; allowlist-protected Telegram actions.
- Database unique keys, transactional job claims, bounded retries, reconciliation on ambiguous sends.

### 3.3 Ownership and separation

- Threads API is the source of truth for whether a post/reply exists.
- Supabase is the source of truth for engagement intent, proposals, actions, approvals, execution attempts and history.
- PRD is the source of truth for intended behaviour.
- Telegram is a **control surface**, not durable storage.
- The LLM proposes content, classifications and learning; deterministic code decides permissions, account identity, thresholds, limits and execution.

## 4. Functional requirements

Each item below requires implementation, test evidence and acceptance against the stated criteria. **P0 = foundation, P1 = working core release, P2 = extension, HOLD = permission-gated/deferred.**

### 4.1 Identity and account connection

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| AUTH-01 | P0 | Generate Threads OAuth consent URL with state and exact HTTPS redirect URI | Operator can initiate account connection from Telegram; state is single-use and expires |
| AUTH-02 | P0 | Exchange auth code, obtain/refresh permitted long-lived access token | At least one tester connects; expiry/reconnect state displayed; never log raw tokens |
| AUTH-03 | P0 | Persist immutable provider account ID and granted scopes per connection | Multiple accounts never collide when usernames change |
| AUTH-04 | P0 | Require operator authorization + account binding to persona | Cannot post/reply to unbound, disconnected or unauthorised account |
| AUTH-05 | P1 | Disconnect, reconnect and recover from revoked/expired token | Jobs fail safely and operator is notified instead of silently using wrong token |
| AUTH-06 | P2 | Multiple independent account configurations and per-account quotas | Two connected accounts can be operated without data leakage |

### 4.2 Telegram gateway and approval

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| TG-01 | P0 | Bot created through BotFather; restrict access by Telegram User ID | Unknown user cannot view data or trigger actions |
| TG-02 | P1 | Menu: Engagement Inbox, Accounts, Persona, Settings; Discovery/Insights only when separately enabled | Controls route to real handlers; disabled features clearly marked |
| TG-03 | P1 | Proposal card with account, source reply, proposed response, reason, and inline Approve / Edit / Regenerate / Reject | Each button has persisted action ID; callback answers promptly |
| TG-04 | P1 | Edit-session flow and regenerated preview followed by final approval | Only original operator may edit; edit session expires; new proposal version must be reconfirmed |
| TG-05 | P1 | Clear QUEUED / SENT / FAILED / SKIPPED state and provider permalink | No SENT display until provider outcome confirmed |
| TG-06 | P1 | Repeated callbacks cannot trigger duplicate remote actions | Atomic approval state transitions + idempotent execution |
| TG-07 | P2 | Daily digest, queue status and actionable errors | User can distinguish failed/retrying vs completed actions |

**Engagement execution policy:** a generated reply proposal never sends by itself. Manual and Semi-Auto require an approved current proposal before an engagement job is created. Full-Auto is a separate opt-in policy and is not part of the foundation migration.

### 4.3 Engagement execution

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| EXEC-01 | P1 | Approved engagement proposal creates one durable reply execution job | Pending, rejected, expired or superseded approvals cannot create a job |
| EXEC-02 | P1 | Engagement jobs: pending -> claimed -> processing -> confirmed/failed/needs_reconciliation | Concurrent workers cannot claim the same job |
| EXEC-03 | P1 | Retry transient reply errors conservatively with backoff and rate-limit handling | No blind retry after ambiguous Meta reply outcome; reconcile first |
| EXEC-04 | P1 | Duplicate action prevention | The same approved action key cannot enqueue or execute twice |

### 4.4 Inbound reply engagement

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| ENG-01 | P1 | Sync replies to account-owned Threads roots and supported nested conversations | Reads only replies returned by authorised provider API |
| ENG-02 | P1 | De-dupe incoming events and retain thread context | Same reply does not produce repeat approval cards |
| ENG-03 | P1 | Intent/relevance/risk scoring via configurable LLM + deterministic gate | System can choose SKIP / REVIEW / ELIGIBLE, with reason |
| ENG-04 | P1 | Reply text composed from verified account persona and conversation context | No cross-account persona or wrong-parent replies |
| ENG-05 | P1 | Telegram Semi-Auto approval; after approval, send via supported API and reconcile | One approved reply produces at most one confirmed provider reply |
| ENG-06 | P2 | Account-specific Full-Auto controls (caps, cooldown, confidence, exclusions, kill switch) | Low-risk only; uncertain/high-risk still routed to review |
| ENG-07 | P2 | Supported hide/management operations with explicit operator confirmation | No destructive moderation on model suggestion alone |

### 4.5 Discovery and outbound engagement

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| DISC-01 | P2 | Official keyword search where token/app has capability | Query returns provider-backed, deduped, timestamped results or clear permission error |
| DISC-02 | P2 | Filter by niche, topic, age, excluded accounts and relevance; score opportunities | Bot can explain why each result is suggested |
| DISC-03 | P2 | Present suggestions, never automatically spam public conversations | Approved account limits and provider restrictions enforced |
| DISC-04 | HOLD | Reply to third-party roots if permitted by actual endpoint, scope and app review | Live permission-specific smoke test before feature is enabled |

Keyword results are **not** guaranteed to be a comprehensive “trending chart.” If keyword-search access is unavailable, show a clear unavailable state rather than scraping Threads.

### 4.6 Account insights

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| INS-01 | P1 | Retrieve supported account/post metrics for connected accounts | Store metric name, time, provider ID and permitted values |
| INS-02 | P2 | Per-account overview, top posts, post history, summaries | No invented metrics; unsupported fields shown as unavailable |
| INS-03 | P2 | Daily/weekly optional Telegram digest | Operator can disable digest per account |

### 4.7 Persona creation, multiple accounts and self-learning

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| PER-01 | P0 | Consume the existing external Persona Engine through a minimal account/persona binding contract | PostBro stores only the binding/reference needed for fail-closed engagement authorization; no second persona-learning system is implemented |
| PER-02 | P0 | Verified account -> persona binding; keep separate active versions and preferences | Fail closed on no binding/disconnection |
| PER-03 | P1 | Apply surface-specific guidance to post vs reply generation | Identical account can have distinct post/reply styles |
| PER-04 | P2 | Import accessible **account-owned** historical posts/replies with provenance and authorship tags | User reviews proposed initial persona; no unsupported API access or unconsented third-party history ingestion |
| PER-05 | P2 | Extract writing signals: language mix, register, length, idioms, humour, punctuation, CTA and reply habits | Observation includes source examples and context |
| PER-06 | P2 | Capture Telegram approve/edit/reject/regenerate and final outputs as feedback | Both original and edited texts retained with timestamp and account ID |
| PER-07 | P2 | Group semantically similar preferences and reject non-independent/duplicated evidence | A single duplicated sample cannot satisfy threshold |
| PER-08 | P2 | Candidate threshold: >=3 independent relevant observations, mean confidence >=0.70 | Candidate suggested for review, **not** auto-activated |
| PER-09 | P2 | Promptfoo regression checks + explicit approve/reject/rollback | No activation without explicit approval; previous versions recoverable |
| PER-10 | P2 | Per-account ownership of learning, tenant isolation and retention controls | Data never transfers to unrelated persona/account implicitly |
| PER-11 | P2 | Use post performance as weak supporting evidence, not absolute style authority | Avoid optimise-for-outrage/spam behaviour |

**Learning architecture:** existing engine remains source of persona rules. Lightweight TypeScript Observer/Reflection worker draws on *design ideas* from LangMem and Mastra; neither is a required runtime dependency. Promptfoo is proposed as an evaluation tool. Mem0, DSPy and Honcho are not MVP dependencies.

### 4.8 Automation policy

- Default all new accounts to **Semi-Auto**.
- **Manual:** proactively generated suggestions optional; every send requires direct approval.
- **Semi-Auto:** monitor/draft automatically, but human must approve actual replies.
- **Full-Auto:** only opted-in accounts, supported API operations and low-risk eligible categories; limits, cooldown, duplicate checks and global kill switch are mandatory.
- API failure, identity ambiguity, missing token, low confidence or high-risk content must never bypass review.
- Per-account feature switches: inbound engagement, outbound engagement, insights collection, learning and digest. Posting/scheduling switches belong to Postiz, not PostBro.

### 4.9 Threads DMs

**DM-01 / HOLD:** Determine whether Meta has a documented, publicly available Threads DM read/send API and developer permission. Until verified, there is **no DM automation or browser-based workaround** and no DM-related token request in required setup.

## 5. Key user journeys and state transitions

### 5.1 First account setup

1. Authenticated Telegram operator selects Connect Threads.
2. PostBro issues short-lived signed account-link session and OAuth URL.
3. User authorises in Threads; HTTPS callback verifies state and exchanges token.
4. Backend retrieves immutable Threads account ID and granted scopes, encrypts token, stores connection.
5. Operator selects or creates persona. Account cannot reply until a valid persona binding exists.
6. Bot shows connected status and capability summary; disconnect supported.

### 5.2 Approved engagement reply execution

1. Operator approves a current engagement proposal from Telegram.
2. Approval transition is atomic and bound to operator, account, action key and proposal version.
3. Only a valid approved proposal creates one durable engagement job; duplicate action keys are rejected.
4. Worker claims the engagement job, validates connection/limits and sends the reply through the official Threads API.
5. Worker records provider result; ambiguous network failure becomes needs_reconciliation before any retry.

### 5.3 Inbound reply approval

1. Poll/sync owned reply; upsert unique platform reply ID.
2. Resolve account + reply-surface persona; classify intent/risk and skip unqualified activity.
3. Create one review proposal; send Telegram card with source link and suggested text.
4. Approve / Edit / Regenerate / Reject updates durable review state.
5. Approved execution claims action once and sends via supported reply API; reconcile results and update card.
6. Save feedback evidence (including edits) for learning worker without automatically changing persona.

### 5.4 Learning review

1. Import authorised history and feedback events.
2. Observer extracts account/surface-specific patterns with original examples and confidence.
3. Reflection merges semantically related evidence, checks independence and contradictions.
4. Once candidate threshold reached, run evaluations against existing approved persona on a fixed fixture set.
5. Telegram shows proposed update + supporting examples + before/after outputs, with Approve / Reject.
6. Approval versions learned guidance; rollback reverses the active version. Never silently overwrite base persona.

## 6. Data model (initial proposal; migrations required)

| Table / entity | Role / unique conditions |
|---|---|
| operators | Telegram User IDs, roles and authorised state |
| oauth_sessions | Short-lived single-use state/nonce + initiating operator |
| threads_accounts | Provider ID, username/display data, scopes, encrypted credentials, expiry, status |
| personas | Stable base persona, owner/account scope |
| persona_versions | Immutable snapshots, active version, provenance |
| persona_bindings | One active persona per provider account; verified identity |
| persona_observations | Per-source evidence with originality/quality labels |
| learning_candidates | Statement, evidence IDs, confidence, state and evaluation |
| engagement_jobs | Approved reply execution state, next retry time, claim lease, attempt state and uniqueness key |
| engagement_events | Provider reply ID unique per account; context + classification |
| engagement_proposals | Proposed text, reasons, confidence and lifecycle |
| approvals / edit_sessions | Telegram user/message mapping, one-time action, expiry and edits |
| execution_attempts | Action keys, provider request/result, reconciliation state |
| discovery_results | Search source, query, provider ID, timestamp and relevance |
| insights_snapshots | Provider metric time series and availability |
| audit_events | Operator/system actions, account, reason, timestamp and outcome |

All tables must be account-scoped where applicable. Use database constraints/transactional claim functions for uniqueness and state transitions. Tokens encrypted at the application boundary; do not store sensitive token values in audit or analytics records. Define migrations before implementing engagement execution workers.

## 7. External integrations: what to obtain, what to build, how to verify

Full click-through checklist: [SETUP.md](SETUP.md). **Never paste secrets into GitHub, a Telegram bot chat or the PRD.**

| Subsystem | Obtain from owner/setup | Build/configure | Proof of completion |
|---|---|---|---|
| **Meta Threads App** | Threads App ID, Threads App Secret; app configured for Threads, app/tester roles; stable allowed OAuth redirect URI | OAuth state, code exchange, long-lived token/refresh, encrypted per-account storage, capability handling | Real test account signs in; account ID & grants verified; token refresh/reconnect test |
| **Meta permissions** | Request/grant only needed engagement scopes: threads_basic plus the currently verified official reply read/manage scopes; insights and keyword search only when those features are implemented/approved. Revalidate whether any publishing scope is needed for reply creation before requesting it. | Per-feature capability checks; graceful denial | Reply/insights smoke tests; discovery not enabled until capability verified |
| **Telegram** | New bot token from @BotFather, approved Telegram User ID(s); optional secure webhook secret | Bot commands/menu, callbacks, allowlist, webhook (production) or polling (development), approval state machine | /start from allowed ID works; unapproved ID denied; callback double-click safe |
| **Supabase** | Dedicated/existing project choice, project URL, new server-side secret API key, private database connection URL for migrations, Storage bucket name | Tables/migrations, RLS/least-privilege design, storage policies, connection, encrypted token columns | API + DB tests, storage read/write test, unauthorised access denied |
| **Cloud LLM** | Provider choice, endpoint if non-default, model IDs and API key | Provider adapter, structured outputs, scoring, generation, timeout/fallback, prompt/version logs | Deterministic mock and one real provider smoke test |
| **Public HTTPS / VPS** | VPS SSH access, persistent domain or stable HTTPS tunnel URL, DNS access; optional Cloudflare credentials where relevant | Docker deployment, TLS/reverse proxy, /health, secure secrets, backup, restart and process logs | OAuth redirect matches and works publicly; posts execute while operator laptop is off |
| **GitHub** | This repository and maintainer access (already confirmed) | CI, branch policy, documentation and code migration | Docs committed, checks run on PR, secrets not stored in repo |

**Supabase current guidance (Oct 2026):** use SUPABASE_SECRET_KEY (sb_secret_...) server-side, rather than starting a new app on the deprecated legacy service_role JWT key. SUPABASE_PUBLISHABLE_KEY is only needed if a client-side app directly uses Supabase; it is optional for Telegram-first V1. The management personal access token is **not** needed for normal runtime. DATABASE_URL is for direct Postgres/migrations and must also remain secret.

**Meta testing:** an unpublished Development Mode app is suitable for eligible app roles/Threads testers. Add each required account and accept its invite before OAuth. Public-user rollout is a separate App Review/Live Mode milestone; never assume keyword search, third-party replies or DM access are covered by a basic tester grant.

**Telegram:** a bot token is needed, not a Telegram API ID/hash used by MTProto user clients. Capture the actual Telegram User ID(s) after /start, not solely mutable @usernames.

## 8. Runtime configuration contract

Expected environment variables are maintained exactly in [../.env.example](../.env.example). Categories:

- **Application:** NODE_ENV, PORT, PUBLIC_BASE_URL, APP_TIMEZONE.
- **Meta:** THREADS_APP_ID, THREADS_APP_SECRET, THREADS_REDIRECT_URI, THREADS_SCOPES.
- **Telegram:** TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_MODE.
- **Supabase:** SUPABASE_URL, SUPABASE_SECRET_KEY, DATABASE_URL (migrations), DATABASE_SSL_MODE, DATABASE_SSL_CA_PATH, SUPABASE_STORAGE_BUCKET; SUPABASE_PUBLISHABLE_KEY optional.
- **Security:** TOKEN_ENCRYPTION_KEY (32-byte random key), APP_SIGNING_SECRET.
- **LLM:** LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL if needed.
- **Workers:** ENGAGEMENT_JOB_POLL_INTERVAL_SECONDS, REPLY_POLL_INTERVAL_SECONDS, AUTO_ENGAGEMENT_ENABLED=false, DEFAULT_AUTOMATION_MODE=semi_auto.

Environment names are a **proposed interface**, not proof that an application already reads them. When implementation differs, update this contract and template together.

## 9. Release plan and definition of done

| Phase | Deliverables | Exit gate |
|---|---|---|
| **P0 / Documentation & foundation** | PRD, setup contract, repo scaffolding, CI, database migrations, OAuth and authz | Real tester connects safely; account-persona binding resolves; security tests pass |
| **P1 / Inbound engagement** | Reply sync, persona-based decision, approval buttons, durable reply execution with idempotency, audit | Real comment -> approved reply -> one confirmed Threads reply |
| **P1C / Basic insights** | Supported account/post metrics and bot status | Real metrics fetched without fabricated values |
| **P2A / Persona learning** | Historical import, feedback capture, observation/reflection, evaluations, approval/version rollback | Persona update is evidenced, user approved, and reproducibly evaluated |
| **P2B / Extended Threads** | Permission-gated discovery, outbound engagement permissions smoke test, multi-account controls | Each feature enabled only after actual capability test |
| **Future / Productisation** | Optional web dashboard, team roles, customer auth, App Review, DM reassessment | Separate PRD revision |

**Milestone order is binding unless changed in the PRD; no unreviewed features should be represented as completed.**

## 10. Security, reliability, privacy and observability

- No actual API credentials, bearer tokens, session cookies, user PII dumps or secrets in Git, logs, prompts, tests or Telegram approval messages.
- Stable HTTPS for Meta redirect; OAuth state must be cryptographically random, bound to initiating operator and single-use. Protect account linking against callback CSRF/account mix-ups.
- Encrypt per-account user access tokens at rest. Rotatable key and safe reconnect process required.
- Telegram callbacks are authorised server-side and tied to operator, intended account and immutable action ID. Reject stale/expired, replayed or mismatched callbacks.
- Bounded retry/backoff with remote reconciliation for ambiguous send outcomes. Respect Meta API limits. Use atomic DB claims; don't rely on process-local memory.
- Explicit per-account opt-in for Full-Auto; pause switch and daily caps; never silently send AI proposals from external inputs.
- Historical data ingestion limited to provider-authorised scope, with identifiable authorship, retention and deletion mechanism. Treat third-party comments as untrusted prompt input.
- Store UTC timestamps, convert to chosen user timezone for display; posting schedule display remains with Postiz.
- Emit structured logs (with redaction), job attempt metadata, connector health, token refresh alerts, error summaries and backup/recovery procedure.
- Unit tests for persona resolution, thresholds, state transitions, date/time and permissions. Integration tests use mocks first and a dedicated real tester account thereafter. Promptfoo fixtures check behavioural regressions.

### Minimum acceptance tests

1. Unknown Telegram user cannot operate PostBro.
2. OAuth forged/replayed state rejected; test account token stored encrypted.
3. Two accounts cannot accidentally share persona or tokens.
4. Engagement job not lost after restart; cancelling before execution prevents reply sending.
5. Repeated Approve presses result in one engagement job/execution.
6. Ambiguous reply failure does not auto-create duplicate reply.
7. Persona observation cannot activate without explicit approval.
8. Disabled API permission displays actionable, non-misleading error.
9. Credentials do not appear in the Git tree or application logs.
10. A recorded end-to-end dogfood run links actual provider results to approval and audit records.

## 11. Risks, dependencies and assumptions

| Risk | Mitigation / current decision |
|---|---|
| Meta scopes, API limits and third-party reply access change | Validate per capability against official current docs and a live tester token; gate unverified flows |
| Threads DM API not verifiably public | HOLD; no browser automation or fake promise |
| Credential leaks | Server-side storage, encryption, least privilege, rotations, no actual secrets in repository |
| Duplicate replies after crash/network timeout | DB engagement-job claims and reconciliation before retry |
| AI produces unnatural, repetitive or risky replies | Human approval default, persona grounding, quality evaluation, limits and skip mode |
| Learning overfits likes or AI-generated history | Provenance labels, independent evidence, human review and rollback |
| Scope/complexity grows before usable MVP | Complete P0 and P1 text post + inbound approval before trend/memory optimisations |
| Vendor/hosting variability | Provider adapters; keep one VPS + hosted DB; postpone premature infrastructure |

### Open decisions (must be settled before relevant implementation)

- [ ] Choose Supabase project (dedicated new vs existing) and region.
- [ ] Choose stable HTTPS hostname; avoid a rotating quick-tunnel URL for persistent OAuth redirect.
- [ ] Choose cloud LLM provider/model pair and budget limits.
- [ ] Choose exact daily action caps/cooldowns and first account for dogfood.
- [ ] Confirm user-visible timezone policy and Telegram operator allowlist.
- [ ] Verify available Meta API permissions for keyword discovery and replying to third-party content via controlled test.
- [ ] Agree retention period for imported historical content and learning evidence.
- [ ] Choose whether to keep source available under a particular license; do not copy AGPL code without license assessment.

## 12. Documentation governance and references

1. **docs/PRD.md** (this document): product requirements and acceptance truth.
2. **docs/SETUP.md**: executable checklist, credential inventory, owners, verification and blockers.
3. **.env.example**: example environment keys, no values resembling real credentials.
4. **README.md**: concise navigation and high-level identity.

For a scope-changing decision: record what changed and why in the PRD, update setup/variable contract, update tests/acceptance, then implement. Mark requirements completed only with evidence (commit, test, observed provider action).

**Official references used to prepare this specification:**
- Meta Threads official API collection: https://www.postman.com/meta/threads/collection/dht3nzz/threads-api
- Meta Threads developer documentation/changelog: https://developers.facebook.com/docs/threads/
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram BotFather: https://t.me/BotFather
- Supabase API key guidance: https://supabase.com/docs/guides/getting-started/api-keys
- Supabase secure data guidance: https://supabase.com/docs/guides/database/secure-data
- LangMem reference: https://github.com/langchain-ai/langmem
- Mastra reference: https://github.com/mastra-ai/mastra
- Promptfoo evaluation: https://github.com/promptfoo/promptfoo
