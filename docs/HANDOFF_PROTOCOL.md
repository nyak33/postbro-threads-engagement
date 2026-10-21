# PostBro — Agent-to-Reviewer Handoff Protocol v1

**Goal:** The owner is a decision-maker, not a technical courier. Hermes sends a short, consistently structured report from Telegram OR CLI; a linked GitHub Pull Request contains authoritative diff and evidence for ChatGPT review.

## Required short report

End every scoped task with EXACTLY one self-contained block in this shape. Use truthful values, one line per field, no secrets. May include an extra one-line note if needed.

~~~text
POSTBRO_HANDOFF_V1
TASK_ID: PB-P0-001
TITLE: <short task title>
STATUS: READY_FOR_REVIEW | IN_PROGRESS | BLOCKED | FAILED
REPO: nyak33/postbro-threads-engagement
BRANCH: <feature branch or NONE>
BASE: <base branch and, where known, SHA>
COMMIT: <full commit SHA or NONE>
PR: <exact GitHub PR URL or NONE>
SCOPE: <one-sentence implemented scope>
FILES: <changed file paths or count plus PR reference>
TESTS: <PASS n / FAIL n / NOT_RUN n; exact commands/results in PR>
ACCEPTANCE: <requirement IDs satisfied and evidence, else UNVERIFIED>
SECURITY: <secret check status; live side effects YES/NO and approvals>
BLOCKERS: <NONE or specific IDs and reason>
RISKS: <NONE or short remaining technical risk>
NEXT: REVIEW_PR | PROVIDE_CREDENTIALS_SECURELY | APPROVE_ACTION | FIX_BLOCKER | OTHER
END_POSTBRO_HANDOFF_V1
~~~

Machine parsing is optional; line names and status vocabulary are mandatory. Use literal `NONE` for absent links, no fabricated SHAs, no green PASS based only on agent narration.

## Full evidence in the PR

1. Task ID, PRD acceptance IDs and links to task spec.
2. Scope vs out-of-scope, changed paths and short architecture rationale.
3. Actual commands, exit codes, test summary, failing/skipped tests, dependencies. Include a minimal sanitized log excerpt or action run URL, not raw credential-bearing output.
4. Security/authorization/account-isolation/duplicate-send checks appropriate to touched modules.
5. Database migration/release/rollback impact and any external operations with explicit approval evidence.
6. Reviewer-ready unresolved questions, blockers, risks and a requested decision. No claims that "tests passed" without commands/results.
7. PR must remain unmerged until reviewed/approved by owner.

## Failure / no write credential path

If VPS cannot push (currently read-only deploy key), return STATUS: BLOCKED and PR: NONE; say GITHUB_WRITE_ACCESS in BLOCKERS with factual reason. Local commit evidence is not independently reviewable from GitHub. Do not request secrets in Telegram or make the user paste private code. Store work in a safe feature branch locally and pause.

If real Meta/Supabase/Telegram integration cannot be exercised, label NOT_RUN / UNVERIFIED with specific missing prerequisite; mocks do not prove a live provider action.

## Reviewer decision contract

Review actual PR diff (not only the report) and respond in plain language:

- **PASS:** reviewed implementation/criteria and available evidence sufficient for the stated task; specify what was NOT tested.
- **CHANGES_REQUIRED:** precise failing requirement, file/behaviour, requested correction, how to verify.
- **BLOCKED:** missing rights, permissions, credentials, provider capabilities, dependency or evidence; name exactly one next unblocking action.
- Owner controls whether to merge, enable live automation or proceed to another milestone.

## Illustration (fictional; not a completed PostBro task)

~~~text
POSTBRO_HANDOFF_V1
TASK_ID: PB-P0-001
TITLE: Fastify scaffold
STATUS: READY_FOR_REVIEW
REPO: nyak33/postbro-threads-engagement
BRANCH: feat/PB-P0-001-scaffold
BASE: main @ <SHA>
COMMIT: <actual SHA>
PR: <actual GitHub URL>
SCOPE: Basic server and health endpoint only
FILES: src/app/*, package.json, tests/health.test.ts
TESTS: PASS 3 / FAIL 0 / NOT_RUN 0; see PR
ACCEPTANCE: Health endpoint and lint/typecheck/tests; see PR
SECURITY: No secrets detected; no live Threads actions
BLOCKERS: NONE
RISKS: No Meta OAuth integration yet (outside this task)
NEXT: REVIEW_PR
END_POSTBRO_HANDOFF_V1
~~~

All values in this example are placeholders, not verification of implementation.
