# PostBro — Integration Contract and Evidence Checklist

This is a technical boundary summary, NOT a secret inventory. Detailed provisioning instructions and current setup tracker are in `SETUP.md`; variable names are in `../.env.example`. None of the listed application connectors should be called ready without an explicit live verification record. The Hermes development bot/provider are separate integrations.

| Dependency | Owner obtains securely | Implementation boundary | Required proof |
|---|---|---|---|
| Meta Threads App | Threads App ID/Secret, eligible tester role, approved exact HTTPS redirect, granted scopes | Fastify OAuth state + callback, provider ID, token exchange/refresh, encrypted storage, permission gate | Real authorized tester connects; invalid/replayed state fails; scope denial handled |
| Telegram **PostBro product** bot | Separate BotFather token and allowlisted numeric IDs | Product bot long polling initially; webhook only after HTTPS available, callbacks bound to operator/action | Authorized/unauthorized user checks, repeat-click tests, final status updates |
| Supabase Cloud | Project URL, protected server secret, DB URL for migrations | Postgres migrations, account isolation, atomic engagement jobs and approvals | DB health, migration reproducibility, cross-account denial, concurrent-claim tests |
| Hosted LLM | App-specific provider model/key and optional base URL | Validated structured scoring/drafts/learning adapter with timeout/fallback | Deterministic tests + explicit real test; no model output alone can authorize send |
| Contabo VPS + DNS/TLS | VPS admin, chosen stable hostname, DNS and certificates | Docker Compose API/worker and only required HTTPS ports | Container health, restart persistence, OAuth callback verified publicly |
| GitHub | Main repository and scoped reviewed write workflow | Feature branch, PR, future CI, code + evidence handoff | PR diff reviewed and CI runs when implemented |

## API permission discipline

- Request only scopes actually required and granted. Basic app/tester operation does not prove advanced discovery, third-party reply or DM capability.
- Use current official API docs and capability smoke tests to verify endpoint behaviour and rate limits at the time of feature implementation.
- No browser scraping/session-based workaround for disabled Meta API operations.
- Each external action requires immutable Threads account ID and deterministic authz check. Persist provider request/result with safe redaction and reconciled IDs.

## Development-vs-product separation

Hermes on VPS and its Telegram development gateway were verified in an operator session. Its Kimi K3 Rootsys key, approval rules, bot token, memory and session records are NOT PostBro app integrations. Never automatically import/reuse those secrets into application files. Build and separately verify all app connectors in a staged task.

## Operational safe defaults

- Secrets only in protected runtime environment / authorized secrets store, never repository, PR or Telegram.
- PostBro new accounts default Semi-Auto. External replies require approval; Full-Auto reply execution is a separate opt-in policy. Posting/scheduling confirmations belong to Postiz.
- Stable HTTPS domain is prerequisite for real persistent Meta OAuth redirect. Use mocked testing first; live tests on designated developer tester with explicit owner approval.
- Capture what changed, which tests ran, exact outcomes and which prerequisites remain blocked. Use `HANDOFF_PROTOCOL.md` for reviewer transfer.
