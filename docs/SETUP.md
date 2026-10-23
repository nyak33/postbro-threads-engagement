# PostBro — Integration Setup & Credential Checklist

**Status:** PostBro application integrations remain unconfigured/unverified; development Hermes/VPS/GitHub tooling is tracked separately below.  
**Last reviewed:** 2026-10-21  
**Source of truth for product scope:** [PRD.md](PRD.md)  
**Environment name contract:** [../.env.example](../.env.example)

**Rule:** Never paste private keys or secrets in GitHub issues, commits, pull requests, chat, Telegram, screenshots or documentation. Put them only in a protected local runtime environment, encrypted deployment secret manager or secure VPS secret file. Use placeholders in this checklist.

## 0. Status and responsibility legend

- **Owner:** Create/select service and obtain credentials through its authenticated dashboard.
- **Engineering:** Build/configure connector, migrations, workers and tests.
- **Verify:** Run a live smoke test and record evidence (without keys).
- **Blocked:** Do not call a component ready until its dependencies pass.

Project setup tracker:

| ID | Component | Owner must obtain/provide securely | Engineering | Verification | Status |
|---|---|---|---|---|---|
| S-01 | GitHub | Repository nyak33/postbro-threads-engagement | PRD, checklist, CI | PRD, checklist and env template committed; CI remains pending | Documentation complete; CI pending |
| S-02 | Meta Threads App | Threads App ID + Threads App Secret + approved redirect | OAuth connector/token refresh | Tester account connected | Not started |
| S-03 | Threads testers | Account role/invite acceptance | Account selection and scopes check | Both app role and OAuth confirmed | Not started |
| S-04 | Supabase | Project URL + server-side secret key + DB migration URL | Local schema, hardened migration runner, least-privilege role plan, TLS/network strategy, isolation and concurrency tests | Local disposable PostgreSQL tests pass; hosted DB queries + bucket test | Local foundation and hosted-readiness hardening implemented; hosted migration NOT configured or run |
| S-05 | Telegram | Bot token + authorised Telegram User ID(s) | Bot, callbacks, menus | Allowed /start and double-click test | Not started |
| S-06 | Cloud AI | API key + model/provider selection | Provider adapter, budget/timeout | One test generation + scoring | Not started |
| S-07 | VPS + HTTPS | Host access, domain/tunnel and DNS | Containers, TLS, health, logs | OAuth callback and worker uptime | VPS development tools provisioned; PostBro deployment/HTTPS NOT started |
| S-08 | Persona engines | Source repositories (available separately) | Adapt, test, connect to Meta account IDs | Persona test suite + account isolation | Not started |
| S-09 | Scope-gated features | Meta search/other capabilities as approved | Discovery/outbound implementation | API capability smoke | Blocked until access verified |


### Development environment checkpoint (distinct from PostBro application integration)

Recorded from owner-operated Contabo session on 2026-10-20; **not a live check in this PR**:

- Contabo Ubuntu 24.04 VPS: `postbroadmin` user, SSH key authentication and UFW; Git, Docker/Compose, Node.js and Hermes were installed and tested.
- Hermes CLI replied `HERMES_OK` using configured Kimi K3 via Rootsys; Hermes **development** Telegram gateway replied `TELEGRAM_OK` and ran `whoami` -> `postbroadmin`.
- Hermes gateway ran under enabled user systemd service with linger; `approvals.mode=manual` was configured, service restarted and a dangerous chmod probe triggered Telegram approval and was denied.
- GitHub repository cloned into `/home/postbroadmin/postbro-threads-engagement` using the dedicated SSH deploy key for read/synchronization. Scoped GitHub CLI authentication is configured for feature-branch pushes and PR creation; main remains protected and must not be pushed directly.
- PB-P0-001 scaffold and CI are merged (PR #2). GitHub Actions runs `npm ci`, lint, typecheck and the current test suite on PRs.
- **Do not interpret the above as completing S-05 (PostBro product Telegram bot), S-06 (PostBro app's LLM integration) or S-07 (PostBro API/worker public deployment).** A separate PostBro bot, stable HTTPS callback, Supabase, Meta app and live code have not been verified. Never copy Hermes secrets into PostBro environment.
- Before beginning each development milestone, re-check the relevant live state and record actual evidence, rather than assuming this dated checkpoint remains correct.

See `ARCHITECTURE.md`, `DEVELOPMENT_WORKFLOW.md` and `INTEGRATIONS.md` for module contracts and reviewable process.

## 1. Meta Threads developer application (S-02 / S-03)

**Official entry:** https://developers.facebook.com/apps/  
**API reference:** https://www.postman.com/meta/threads/collection/dht3nzz/threads-api

### Owner: obtain/configure

- [ ] Open your Meta developer account; create or select a Meta app with the **Threads use case**.
- [ ] In Threads app settings, locate and securely record **Threads App ID** -> THREADS_APP_ID and **Threads App Secret** -> THREADS_APP_SECRET. These are the Threads-specific credentials, not automatically interchangeable with generic Facebook App credentials.
- [ ] Set a stable, publicly accessible **HTTPS OAuth redirect URI**, suggested: https://YOUR-HOST/auth/threads/callback. The exact string must match both Meta settings and THREADS_REDIRECT_URI.
- [ ] For an unpublished development-mode app, add each selected test Threads identity to its appropriate **Threads Tester** role and have the invited account accept the invitation. Check available Meta dashboard menu names; they may change.
- [ ] Make sure requested permissions match the intended features; minimum target: threads_basic and threads_content_publish. Add threads_read_replies, threads_manage_replies and threads_manage_insights as those features are implemented.
- [ ] Treat threads_keyword_search / other discovery permissions separately. Confirm actual current Meta access requirements, app role and advanced access before enabling the discovery feature.
- [ ] Do **not** switch app live/publish merely for our tester dogfood. Public onboarding later requires the applicable review and app access.

### Engineering: implement

- [ ] Endpoint starts a short-lived signed operator-to-OAuth connection session and stores single-use random state.
- [ ] Exact authorisation URL and granted scopes verified; callback rejects invalid/replayed/expired state and binds provider identity to the correct Telegram operator.
- [ ] Exchange authorization code for token, exchange for long-lived token if applicable, record expiry and refresh safely ahead of expiry.
- [ ] Encrypt stored per-account tokens (TOKEN_ENCRYPTION_KEY); no access token in Telegram cards, logs or browser local storage.
- [ ] Support account reconnect, revoke/disconnect, account list and capability-aware errors.
- [ ] Use immutable provider account IDs. Keep personas, jobs, learned memory and limits account-specific.

### Verify (live)

- [ ] Tester account OAuth completes; backend obtains /me identity without leaking credentials.
- [ ] Test real text publish and store confirmed post ID/permalink.
- [ ] Replayed state rejected; wrong user/account cannot hijack pairing.
- [ ] Token expiry/refresh and permission-denial cases handled.
- [ ] Feature switches reflect actual granted and verified capabilities.

**Variables:** THREADS_APP_ID, THREADS_APP_SECRET, THREADS_REDIRECT_URI, THREADS_SCOPES, TOKEN_ENCRYPTION_KEY, APP_SIGNING_SECRET, PUBLIC_BASE_URL.

## 2. Supabase hosted Postgres + Storage (S-04)

**Dashboard:** https://supabase.com/dashboard  
**Official API key docs:** https://supabase.com/docs/guides/getting-started/api-keys

### Owner: obtain/configure

- [ ] Choose a **dedicated PostBro Supabase project** if practical; otherwise explicitly designate a separate schema/project isolation strategy in an existing project.
- [ ] Choose nearest appropriate region, noting hosting latency/data locality and cost.
- [ ] Get Project URL from Project Settings / Connect -> SUPABASE_URL.
- [ ] Get or create a **new secret API key**, prefix sb_secret_, from API Keys -> SUPABASE_SECRET_KEY. This replaces the legacy service_role key for new code. **Never expose it client-side**.
- [ ] Obtain the database connection string/credentials for migrations -> DATABASE_URL. Select direct/transaction pooler as appropriate for the migration tooling; keep it private.
- [ ] Create a Storage bucket, proposed name postbro-media, and record it as SUPABASE_STORAGE_BUCKET. Configure deliberate public media delivery for assets Meta must fetch, without making the entire private asset library public.
- [ ] Optional: SUPABASE_PUBLISHABLE_KEY (sb_publishable_...) if/when a future web client reads Supabase directly. Not essential for Telegram-only backend.
- [ ] **Not required:** Supabase personal access token, management API token or service_role legacy key for normal app runtime. Only request a Supabase management token if automation specifically uses the Supabase management API.

### Engineering: implement

- [ ] SQL migrations for all PRD entities, indexes, foreign keys and account isolation.
- [ ] RLS/grants appropriate to access model. Backend secret key bypasses RLS, so enforce strict operator + account authorisation in service layer.
- [ ] Build durable queue claims/leases and compare-and-swap approval transitions at the database level.
- [ ] Encrypt Meta credentials before inserting them in DB; exclude plaintext and ciphertext from analytics/error logging.
- [ ] Configure object upload, MIME/size policy and publicly retrievable temporary/published media URLs for Meta fetch where necessary.
- [ ] Record data retention/deletion procedures, DB backup/restore and secret rotation plan.

### Verify

- [ ] Health check confirms database connectivity.
- [ ] Migration up/down or reproducible clean schema installation passes.
- [ ] Create/retrieve account, draft, schedule, approval and audit row; correct account isolation.
- [ ] Simultaneous job claims result in one claimant; revoked approval never sends.
- [ ] Media uploaded, then fetched by provider-compatible public HTTPS URL; unauthorised private object not accessible.

**Variables:** SUPABASE_URL, SUPABASE_SECRET_KEY, DATABASE_URL, SUPABASE_STORAGE_BUCKET; optional SUPABASE_PUBLISHABLE_KEY.

## 3. Telegram Bot Gateway (S-05)

**Bot creation:** https://t.me/BotFather  
**API docs:** https://core.telegram.org/bots/api

### Owner: obtain/configure

- [ ] Start a conversation with the verified @BotFather Telegram bot.
- [ ] Use /newbot, choose name and unique username.
- [ ] Securely obtain the resulting **Telegram Bot Token** -> TELEGRAM_BOT_TOKEN. Never send this token *to* the bot as a chat message.
- [ ] Determine operator's numeric **Telegram User ID** (not username) using an authenticated /start event and backend log with redaction, or another reliable method. Add approved IDs as comma-separated TELEGRAM_ALLOWED_USER_IDS.
- [ ] Optionally configure /setcommands in BotFather: start, menu, accounts, create, schedule, inbox, discover, insights, persona, settings, status, help.
- [ ] Keep the bot private for dogfood; never treat public bot discovery as user authorisation.

### Engineering: implement

- [ ] Local/dev uses **long polling** first (fewest infrastructure dependencies); stop polling before switching to webhook.
- [ ] Production uses Telegram HTTPS webhook with a random TELEGRAM_WEBHOOK_SECRET; verify incoming Telegram secret token header. Only one update delivery mode at a time.
- [ ] Verify every sender's Telegram user ID against allowlist, **including inline callback queries**.
- [ ] Create main menu with Inline Keyboard, approve/edit/regenerate/reject proposal cards and schedule preview buttons.
- [ ] Map message + callback IDs to durable approval records, with 30-minute default edit session expiration (configurable).
- [ ] Callback state is single-use; double-click, forwarded message or replay cannot execute twice.
- [ ] Bot edits existing status card to Confirmed / Failed / Needs Review after provider outcome; notification failure does not change DB truth.

### Verify

- [ ] Allowed /start works; unknown Telegram User ID rejected.
- [ ] Approve -> executes once; Edit -> prompts for revised text and reapproval; Reject -> never publishes.
- [ ] Restart does not lose pending approvals; expired callbacks refused.
- [ ] Webhook secret and Telegram API calls work on deployed endpoint.

**Variables:** TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, TELEGRAM_MODE, TELEGRAM_WEBHOOK_SECRET, PUBLIC_BASE_URL.

## 4. Cloud LLM / AI gateway (S-06)

### Owner: obtain/configure

- [ ] Choose one provider offering a compatible hosted API for generation and structured classification.
- [ ] Obtain its API key -> LLM_API_KEY. Choose generation/scoring model ID -> LLM_MODEL.
- [ ] If provider uses a configurable OpenAI-compatible URL, record -> LLM_BASE_URL. Define LLM_PROVIDER label.
- [ ] Set budget, rate limits and spending alert; no provider key is required until AI tests start.
- [ ] Optional future: distinct scoring and generation models; no initial requirement for Hermes.

### Engineering: implement

- [ ] Provider adapter with timeout, bounded retry, response validation, model ID and trace ID.
- [ ] Separate intent/risk classification, reply drafting, style observation and reflection prompts.
- [ ] No raw user-supplied comments may override system/provider instructions. Constrain structured JSON and enforce deterministic send eligibility in code.
- [ ] Preserve prompt template version, redacted evaluation examples and user-approved outcomes; add Promptfoo eval tests.
- [ ] Fail closed to review/manual mode if LLM fails or produces invalid schema.

### Verify

- [ ] Model returns a persona-aligned draft in BM/English where configured.
- [ ] Intent/risk scoring produces parseable schema and skip/review outcomes.
- [ ] Bad prompt or provider timeout doesn't auto-publish or send a reply.
- [ ] Learned change improves defined evaluation fixtures before user approval.

**Variables:** LLM_PROVIDER, LLM_MODEL, LLM_API_KEY, optional LLM_BASE_URL.

## 5. VPS, DNS, HTTPS and deployment (S-07)

### Owner: obtain/configure

- [ ] Choose VPS host and region, initial guideline **2 vCPU / 4 GB RAM** (benchmark before committing to production load).
- [ ] Obtain SSH access, public hostname, DNS control and TLS-compatible HTTPS endpoint.
- [ ] Use a **stable hostname or named tunnel**, not a rotating Cloudflare Quick Tunnel for the registered Meta redirect.
- [ ] Decide hostname (example only: https://postbro.example.com) and record PUBLIC_BASE_URL.
- [ ] Keep operating costs, server access and recovery process documented.

### Engineering: implement

- [ ] Docker image and Compose (API, worker process from same codebase); restart policy, health checks, log limits.
- [ ] Reverse proxy/TLS; expose only required HTTPS routes, not the database or admin internals.
- [ ] GitHub Actions CI with lint, typecheck, unit/integration tests, secret scanning and optional deploy.
- [ ] Secure server runtime .env or secret storage: permissions restrictive; no file committed.
- [ ] Production URL checks: /health, /auth/threads/callback, /telegram/webhook.
- [ ] Schedule runner independent of a user laptop, safe restart and time synchronisation.
- [ ] Backups for configuration/DB, basic alerting, resource limits and documented recovery.

### Verify

- [ ] Server remains healthy after restart and developer laptop shutdown.
- [ ] Telegram webhook (if selected) and Meta OAuth callback reachable over valid HTTPS.
- [ ] Due scheduled text post executes and job audit records Meta result.
- [ ] Simulated provider errors show recoverable failure and no duplicates.

**Variables:** NODE_ENV, PORT, PUBLIC_BASE_URL, APP_TIMEZONE, all service keys above.

## 6. Existing code migration (S-08)

- [ ] Review nyak33/postbro-persona-engine: port interview, persona/context compilation, approved learning, account binding; remove reliance on Postiz integration IDs and bind to immutable Meta Threads user IDs.
- [ ] Review nyak33/postbro-inbound-engagement-engine: reuse classifier/relevance/risk/safe reply patterns. **Resolve existing SEMI_AUTO behaviour conflict**: new PRD requires human approval for every reply in Semi-Auto.
- [ ] Review nyak33/postbro-engagement-threads: adapt provider methods to **direct official Meta Threads API**, removing reliance on Postiz bridge and JSON-store idempotency.
- [ ] Review nyak33/threads-operator: selectively port useful Telegram approval patterns and durable queue concepts; do not import legacy scraping or obsolete scheduling infrastructure blindly.
- [ ] Reference nyak33/postbro-postiz Threads OAuth and publishing implementation conceptually, but do not copy AGPL-licensed code into the new repository without licence review.
- [ ] Add unit tests before replacing old components; preserve old repositories unchanged until milestone validation.
- [ ] Add lightweight historical observation/reflection in TypeScript. Use LangMem/Mastra as design references and Promptfoo as evaluation; no extra memory server needed.

## 7. Configure in dependency order

| Sequence | Prerequisite | Unlocks |
|---|---|---|
| 1 | GitHub PRD + setup contract | Reproducible implementation |
| 2 | Stable HTTPS hostname and Meta redirect plan | Reliable OAuth callback |
| 3 | Meta Threads app + testers + credentials | Live Threads account OAuth |
| 4 | Supabase project, keys, schema and encrypted storage | Safe token persistence, account and job records |
| 5 | Telegram bot token + allowed User IDs | Secure control surface |
| 6 | OAuth + Telegram + Supabase integration | Account connection & persona binding |
| 7 | Text publisher, worker and queued approval | Real posting and scheduling |
| 8 | LLM key + Persona/Decision Engine | AI drafts and relevance scoring |
| 9 | Reply polling + approval executor | Working inbound engagement |
| 10 | Insights/learning; additional verified permissions | Discovery, media and full-auto extension |

**Note:** Hostname and Meta app steps may run in parallel; production callback validation requires both. We do not need a paid LLM key to finish database/auth scaffolding. We do not need a GitHub personal token unless an external deployment automation needs repository access.

## 8. Recommended smoke-test record (fill after running)

| Test ID | Action | Expected | Evidence link / result | Status |
|---|---|---|---|---|
| SMOKE-01 | Connect valid tester Threads account | Correct account ID/scopes persisted | TBD | Not run |
| SMOKE-02 | Invalid OAuth state | 4xx and no token stored | TBD | Not run |
| SMOKE-03 | Unauthorised Telegram command | Rejected | TBD | Not run |
| SMOKE-04 | Approve draft + publish text | Confirmed Threads ID/permalink | TBD | Not run |
| SMOKE-05 | Schedule post + restart worker | Executes at correct time once | TBD | Not run |
| SMOKE-06 | Inbound reply -> AI suggestion -> approve | One confirmed reply | TBD | Not run |
| SMOKE-07 | Press Approve twice | Exactly one remote action | TBD | Not run |
| SMOKE-08 | Second account uses different persona | No cross-account mix | TBD | Not run |
| SMOKE-09 | Feedback threshold -> candidate | Proposal only; no auto activation | TBD | Not run |
| SMOKE-10 | Secret scan | No sensitive values committed | TBD | Not run |

## 9. Troubleshooting pointers

| Symptom | First checks |
|---|---|
| Threads login denied | Correct Threads App ID, redirect exact match, tester invitation accepted, scopes and developer mode |
| Threads publish works but replies fail | threads_read_replies / threads_manage_replies access and current API restrictions |
| Discovery returns permission error | threads_keyword_search support/access; do not switch to scraping |
| Bot responds to no one | Bot token valid, polling vs webhook exclusivity, allowed numeric user ID |
| Unknown people can use bot | Immediately disable bot, rotate token if compromised, enforce allowlist on every handler |
| Supabase 401/permission denied | Secret key vs publishable/legacy type, project URL, grants/RLS, server-only context |
| Meta cannot fetch media | Object's public HTTPS URL accessibility, MIME format, size, container readiness |
| Duplicate post after network timeout | Uncertain send was retried without reconciliation or durable idempotency |
| Schedule missed | VPS/worker uptime, DB claim lease, UTC conversion, failed token refresh |

## 10. Source documents

- Product scope: [PRD.md](PRD.md)
- Placeholder env file: [../.env.example](../.env.example)
- Meta docs: https://developers.facebook.com/docs/threads/
- Meta official API collection: https://www.postman.com/meta/threads/collection/dht3nzz/threads-api
- Telegram docs: https://core.telegram.org/bots/api
- Supabase keys: https://supabase.com/docs/guides/getting-started/api-keys
- Supabase security: https://supabase.com/docs/guides/database/secure-data

**This file is a checklist: checked items must be based on actual tests or dashboard inspection, never assumptions.**
