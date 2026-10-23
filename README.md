# PostBro — Threads Automation

Standalone, **Threads-only** platform for publishing, scheduling, AI engagement, discovery, insights, and account-specific persona learning.

> **Project stage:** P0 foundation in progress. A minimal TypeScript/Fastify API scaffold, `GET /health`, configuration validation, six unit tests and GitHub Actions CI are implemented. Meta Threads OAuth, the PostBro product Telegram bot, Supabase, publishing, scheduling and engagement are **not implemented or verified** yet.

## Source of truth

1. **[Product Requirements Document](docs/PRD.md)** — binding scope, user stories, rules, requirements, acceptance criteria, priorities and release gates.
2. **[Integration & Setup Checklist](docs/SETUP.md)** — exactly what to obtain, where to obtain it, what engineers configure, and how to verify each subsystem.
3. **[Environment variable template](.env.example)** — names and sample placeholders only; **never commit real secrets**.

If another document, issue, or implementation conflicts with the PRD, update the PRD through a documented decision before changing intended product behaviour.

## Development and review

- [AGENTS.md](AGENTS.md) — mandatory agent contract; agents must explicitly read it at task startup.
- [Architecture](docs/ARCHITECTURE.md) — proposed module boundaries and safety model.
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) — P0/P1/P2 task IDs, dependencies and gates.
- [Development workflow](docs/DEVELOPMENT_WORKFLOW.md) — owner/ChatGPT/Hermes responsibilities, branch and review process.
- [Handoff protocol](docs/HANDOFF_PROTOCOL.md) — fixed, concise POSTBRO_HANDOFF_V1 report and PR evidence contract.
- [Integrations](docs/INTEGRATIONS.md) — secure provider boundaries and verification.
- [First task specification](docs/tasks/PB-P0-001.md) — backend scaffold implemented and verified in [PR #2](https://github.com/nyak33/postbro-threads-engagement/pull/2); six tests passed in [GitHub Actions](https://github.com/nyak33/postbro-threads-engagement/actions/runs/39912255557/job/120277693442).

Hermes runs separately as the development agent on a VPS and can be contacted via its *development* Telegram bot. This does **not** constitute a PostBro application implementation or provision its own product bot. See `docs/SETUP.md` for separated, evidence-based status.

## V1 architecture

- **User interface:** Telegram bot with inline approvals and conversational commands; a minimal HTTPS page is used for Threads OAuth.
- **API and workers:** Node.js 22+ / TypeScript / Fastify, deployed together initially.
- **Social API:** Official Meta Threads API; the app's own Threads OAuth credentials, no Postiz dependency.
- **Persistence & media:** Hosted Supabase PostgreSQL and Storage.
- **AI:** Configurable cloud-model provider; our existing Persona and Decision Engine code is adapted into this repository.
- **Operations:** Single always-on VPS, containerised deployment, durable schedules and execution history.

**Not in V1:** Instagram, Facebook Pages, general-purpose Postiz integration, full web dashboard, unverified Threads DM automation.

## First milestone

Create a safe end-to-end path: connect a developer/tester Threads account → bind its persona → draft a text post in Telegram → approve/schedule → publish through official API → persist actual result and link. Then add inbound reply approval and self-learning observation.

## Security

- Copy `.env.example` to a local ignored `.env`; do **not** commit `.env`, tokens, client secrets, database passwords, OAuth codes or user data.
- Never send production secrets through Telegram conversations, issues, PR comments or AI prompts.
- Restrict all Telegram actions to an approved user allowlist, and encrypt Threads user access tokens at rest.

## Local development

- Required runtime: Node.js 22 or newer with npm.
- Install exact locked dependencies: `npm ci`
- Start the development server: `npm run dev`
- Compile TypeScript: `npm run build`
- Run static checks: `npm run lint` and `npm run typecheck`
- Run the automated tests: `npm test`

The PB-P0-001 scaffold validates only the health-slice environment (`NODE_ENV`, `PORT`, `APP_TIMEZONE`, optional `PUBLIC_BASE_URL`). Meta, Telegram, Supabase and LLM values remain placeholders in `.env.example` and are not required to run `GET /health` or the test suite.

## License

PostBro original source code and documentation in this repository are released under the [MIT License](LICENSE), copyright (c) 2026 nyak33 and contributors. Preserve license and copyright notices when redistributing. Third-party dependencies and any future imported code retain their own licenses and must be reviewed before incorporation. The npm package remains marked `private: true` to prevent accidental publication; that setting does not restrict GitHub source reuse under MIT.

## Status

- **Complete:** Repository foundation ([PR #1](https://github.com/nyak33/postbro-threads-engagement/pull/1)) and PB-P0-001 Fastify scaffold with six passing CI tests ([PR #2](https://github.com/nyak33/postbro-threads-engagement/pull/2)).
- **In progress:** Remaining P0 dependencies including Supabase schema, operator/account isolation, real Meta Threads OAuth, persona binding and product Telegram bot.
- **Not claimed:** Deployed PostBro service, live social publishing, scheduling, engagement or production readiness. See [the PRD](docs/PRD.md), [implementation plan](docs/IMPLEMENTATION_PLAN.md) and [setup checklist](docs/SETUP.md) for acceptance gates. Only explicit test evidence counts as verification.
