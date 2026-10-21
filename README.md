# PostBro — Threads Automation

Standalone, **Threads-only** platform for publishing, scheduling, AI engagement, discovery, insights, and account-specific persona learning.

> **Project stage:** Specification-first. This repository starts with documentation; no runtime features or integrations are implied by the files here.

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
- [First task specification](docs/tasks/PB-P0-001.md) — proposed scaffold; implementation not started.

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

## Status

All requirement checkboxes start **unimplemented / unverified** until work and evidence show otherwise. See the PRD and setup checklist for individual gates.
