# Allva Backoffice API — Agent Instructions

> **Entry point for any AI coding agent working in `allva-backoffice-api`.** Read this first, then follow §4.
> This file says *how to work here*; the substance lives in `docs/`, the code and `test/architecture/`.
> **Written against:** branch `main`, commit `5f13e9b`, 2026-10-16.

See also:

- [Project Memory](./docs/MEMORY.md)
- [Engineering Rules](./docs/RULES.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Product Requirements](./docs/PRD.md)

---

## 1. Purpose

This service holds the **internal process of the Allva team** — support SLA, assignment history, operator notes, saved views, internal alerts, pre-signature contract drafts and the audit trail of those writes. Every route is staff-only and every product read is made **on behalf of the calling operator**. A plausible change can hand an operator data their permissions do not cover, write product data into the wrong database, or drop an audit record.

> **Understand first. Implement second. Verify before declaring done.**

---

## 2. Project Context

Allva is an **Evidence-based Ads Intelligence** platform. This repo is **not** the product. It is one of three backoffice pieces:

| Piece | Owns |
|---|---|
| `allva-api` | All product data (organizations, accounts, contracts, invoices, subscriptions, integrations, leads, tickets…) **and the platform RBAC matrix** (`../allva-api/src/modules/accounts/domain/platform-rbac.ts`). Issues tokens. |
| `allva-backoffice-api` (this repo) | Internal-process data only, in its **own Postgres** (`allva_backoffice_db`, local port 5433). |
| `allva-backoffice-web` | Navigation, screens, screen guards. Calls both APIs through its BFF. |

Ownership test (from [`docs/backoffice-api.md`](./docs/backoffice-api.md)): *if the customer disappeared tomorrow, would the data still make sense?* Only-for-the-Allva-team ⇒ here. Describes the customer or what they bought ⇒ `allva-api`.

Stack: NestJS 11, TypeScript, Prisma 7 (`prisma-client` generator → `generated/prisma`, `@prisma/adapter-pg`), PostgreSQL 15, zod env validation, Jest, pnpm 8.15.5, Node 22, port **8081**.

**Not in this repo:** Ads platform integrations, AI, billing/payments, customer subscriptions or entitlements, customer organizations as tenants, token issuing, passwords. If a task assumes one of these exists here, stop and confirm — it almost certainly belongs to `allva-api`.

---

## 3. Source of Truth

For **currently implemented behaviour**:

1. Source code (and its pt-BR comments, which record the *why*)
2. `prisma/schema.prisma` + `prisma/migrations/` (the partial index `sla_policies_one_active_per_scope` exists **only** in the migration SQL)
3. Tests — especially the gates in `test/architecture/`
4. Runtime/configuration (`src/shared/infrastructure/config/env.ts`, `configure-app.ts`, `.env.example`, `Dockerfile`, `.github/workflows/`)
5. Architecture documentation ([`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md))
6. Project memory ([`docs/MEMORY.md`](./docs/MEMORY.md))
7. Product / contract documentation ([`docs/PRD.md`](./docs/PRD.md), [`docs/backoffice-api.md`](./docs/backoffice-api.md))
8. Historical context ([`docs/workspace-screen.md`](./docs/workspace-screen.md) — ideation; its role and permission names are **illustrative, not real**)

When documentation and code diverge: do **not** assume either is conceptually right. Name the divergence, find out whether the code moved and the doc went stale (`git log`), preserve existing behaviour until the intent is clear, and update the doc when appropriate. Never change important behaviour just to match an old document.

`docs/backoffice-api.md` is a **specification**, written before the code. Several things it describes are not built (see §7.3). Spec ≠ implementation.

---

## 4. Required Reading

```text
1. AGENTS.md (this file)
2. docs/MEMORY.md
3. docs/RULES.md
4. docs/ARCHITECTURE.md
5. docs/PRD.md — when product/business-rule behaviour is affected
6. Code of the affected module (src/modules/<module>/)
7. Related tests (co-located *.spec.ts + test/architecture/)
8. prisma/schema.prisma + migrations — when persistence is involved
```

| File | Purpose | Read when |
|---|---|---|
| [`docs/MEMORY.md`](./docs/MEMORY.md) | Persistent decisions, reasons, debt, limitations, pitfalls | Before significant work |
| [`docs/RULES.md`](./docs/RULES.md) | MUST / MUST NOT rules; which ones CI enforces | Before modifying code |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Modules, routes × permissions, lifecycle, database, integration | Architectural / cross-module work |
| [`docs/PRD.md`](./docs/PRD.md) | Capabilities and their status | Product / business-rule changes |
| [`docs/backoffice-api.md`](./docs/backoffice-api.md) | Original specification: ownership split, permission matrix, open decisions (§8) | Cross-repo or ownership questions |

`MEMORY.md` is the persistent memory of this repo: it holds decisions that cannot be recovered from reading code in isolation (why introspection and not JWT, why the queue scans the product, why deploy is manual). Its §15 lists the decisions that must not be accidentally reversed.

Sibling repos `../allva-api` and `../allva-backoffice-web` have their own `AGENTS.md` and `docs/`; read them when a change crosses the HTTP boundary. Their docs describe *their* repo, not this one.

**Mandatory** consideration of the relevant documents before: architectural or cross-module changes, database changes, authentication, authorization/permissions, anything touching the `allva-api` contract, audit, security, infrastructure/deploy.

### Memory-First Rule

Before architectural, cross-module, authorization, integration, data-model or infrastructure changes:

1. Read the relevant sections of `docs/MEMORY.md`.
2. Identify previous decisions — including [`docs/backoffice-api.md`](./docs/backoffice-api.md) §8 *open* decisions, which are not yours to close.
3. Check `docs/RULES.md` and `test/architecture/`.
4. Inspect the current implementation.
5. Only then propose or implement the change.

Do not accidentally reverse a documented decision.

---

## 5. Before You Change Code

```text
[ ] Identify the affected module (src/modules/<module>) and layer.
[ ] Read its existing implementation: controller → use case → port → infrastructure.
[ ] Search for similar implementations in other modules (presenters, *-access.ts helpers, find-*.ts).
[ ] Identify consumers: allva-backoffice-web services, hub signal keys, other use cases.
[ ] Check co-located specs and test/architecture/.
[ ] Check prisma/schema.prisma and the migration if persistence is involved.
[ ] Check the permission each use case requires (assertPlatformPermission / operator.can).
[ ] Check per-operator / per-permission visibility (who must NOT see this).
[ ] Check audit: does this write call BackofficeAuditLogService.record?
[ ] Check the allva-api contract (controller + DTO in ../allva-api) for any gateway change.
[ ] Check MEMORY.md for previous decisions.
```

---

## 6. Implementation Workflow

```text
Understand → Locate → Trace dependencies → Identify invariants → Implement → Test → Validate → Document
```

- **Understand** the full request; if it implies product data, it is probably not for this repo.
- **Locate** the module. Request path: `OperatorAuthGuard` (global) → controller in `infrastructure/http/controllers/` (thin, `/api/v1/...`) → use case in `application/use-cases/` → ports in `domain/ports/` → `infrastructure/database/prisma/` repository or `infrastructure/providers/` gateway over `AllvaApiClient`.
- **Trace** who calls it (web BFF, other use cases) and what it writes (local DB, `allva-api`, audit).
- **Identify invariants** from §7.
- **Implement** the smallest correct change, in the existing layer layout. New use case ⇒ register in the module and keep it under ~150 significant lines.
- **Test**, **Validate** (§13), **Document** only persistent knowledge (§14).

Never: `Assume → Generate code → Declare success`.

---

## 7. Critical Invariants

### 7.1 Enforced by CI (`test/architecture/`, run by `pnpm test`)

1. `domain/` imports no `application/`, `infrastructure/`, `@nestjs/*`, `@prisma/client`, `express` or `generated/`.
2. `application/` imports no module `infrastructure/`; only infrastructure touches `PrismaService` / `generated/` (`health` is the one flat module).
3. Every port is an `abstract class`; every module has `domain/`, `application/`, `infrastructure/`.
4. No `*.usecase.ts` above 150 significant lines.
5. **Every use case decides access** (`assertPlatformPermission`, `assertScreenAvailable`, `operator.can(` / `operator.permissions`) or is listed in `OWN_DATA_USE_CASES` with a reason. That list is a ceiling, not a convenience.
6. **No code decides by role** (`platformRole ===`, `'ALLVA_*'` literals).
7. Every `@Controller` route starts with `/api/v1/` and is explicit.
8. The whole `AppModule` DI graph compiles.

Do not weaken a gate (thresholds, regexes, allow-lists) to make a change pass.

### 7.2 Confirmed in code, not gate-enforced

1. **Own database, no product data.** Never connect to `allva_db`; product references (`ticket_id`, `sales_lead_id`, `operator_id`, `subject_id`…) are opaque ids **without FK**. Orphans are handled on read, never cascaded by inference.
2. **Identity comes only from `allva-api` `GET /api/v1/auth/me`.** No local JWT validation, no token issuing. Cache ≤ 60 s (`OPERATOR_INTROSPECTION_CACHE_MS`, zod `max(60000)`), keyed by token hash, only conclusive results cached, 2 s timeout.
3. **Fail closed.** Bad token ⇒ `401 UNAUTHORIZED`; non-operator or incomplete `/auth/me` ⇒ `403 ACCOUNT_NOT_AUTHORIZED`; `allva-api` unreachable ⇒ `503`. Never "allow while allva-api is down".
4. **The RBAC matrix lives only in `allva-api`.** `PLATFORM_PERMISSIONS` here is vocabulary for the compiler, not a matrix. A new permission is added to `allva-api` first, then here.
5. **Authorization lives in the use case**, never in a route guard. The guard only authenticates.
6. **Refusal shape:** `{ code: 'ACCOUNT_NOT_AUTHORIZED', message, details: { permission } }` via `platformPermissionDenied` / `assertPlatformPermission` — the web reads `details.permission`.
7. **Product calls run as the operator** (their bearer, via `Operator.accessToken`). The backoffice-api has no credential of its own and never acts with more power than whoever clicked. Each module reaches `allva-api` through its own port + `infrastructure/providers/` gateway; `AllvaApiClient` is never injected into a use case. `X-Correlation-Id` is propagated.
8. **Every internal write is audited** through `BackofficeAuditLogService.record` (actor, action, subject, before/after, reason, ip, user agent). Audit failure is logged and **never fails the operation**. `backoffice_audit_logs` is append-only: the port has `save` and `list` only.
9. **Hidden means absent:** a note or saved-view screen the operator may not see answers `404`, not `403`.
10. **Wire formats match `allva-api`:** pagination `{ items, total, page, pageSize }`; errors `{ code, message, details? }` in `SCREAMING_SNAKE_CASE`; `GET /api/v1/hub/attention` has exactly the shape of `allva-api` `GET /api/v1/admin/attention` (`count: null` = failed, not zero; signals filtered by permission; severity order). Signal keys are a contract with `allva-backoffice-web`.
11. **SLA:** due dates are fixed when a ticket is first seen and never recomputed by `observe`; one active policy per (priority, category) scope; `FALLBACK_SLA_TARGETS` apply when no policy matches.
12. **Contract drafts:** conversion is idempotent (already converted ⇒ no second product call); a converted draft is not editable (`409 CONTRACT_DRAFT_ALREADY_CONVERTED`); the signed PDF is product data and is never stored here.

### 7.3 Specified but NOT implemented (`docs/backoffice-api.md`) — do not present as existing

Full list with reasons: [`docs/MEMORY.md`](./docs/MEMORY.md) §16–18. The ones most likely to mislead:

- Background jobs: ticket polling, escalation (every 5 min), alert evaluation/dispatch. SLA snapshots update **on read** (`TicketSlaTrackerService`), so hub counts cover only tickets someone already opened; `escalated_*` columns are never written.
- `businessHours` on SLA policies is stored but ignored: deadlines run in calendar minutes.
- Nothing creates `AlertEvent` rows; `EMAIL`/`SLACK` channels are stored, never sent.
- Service credential / service role for jobs (open decision §8.4, needs `allva-api` first).
- Per-operator rate limit on write routes.
- Metrics: median/p90 and resolved/reopened volumes return `null`.
- Assignment reconciliation (spec §4.1.1): if the local event write fails after `allva-api` accepted the assignment, the use case throws; nothing reconciles `[VERIFY]`.
- Signature-provider webhook for drafts.

---

## 8. Module-Specific Checks

| Module | Check before changing |
|---|---|
| `auth` | Introspection cache/timeout limits, fail-closed mapping, `OWN_DATA_USE_CASES`, `PLATFORM_PERMISSIONS` parity with `allva-api` |
| `support` | `domain/sla.ts` (pure, `now` is a parameter), `TicketSlaTrackerService`, reassignment reason rule (`ASSIGNMENT_REASON_REQUIRED`), assignee written in **`allva-api`** first, `sla` filter scan cap (`MAX_TICKETS_SCANNED_FOR_SLA_FILTER`) |
| `operations-hub` | Signal catalog, permission filtering, `null` on failure, shape parity with `allva-api` |
| `internal-notes` | `NOTE_SUBJECT_PERMISSION` per subject, `visibilityPermission`, author-or-`settings:manage` moderation, soft delete |
| `preferences` | Own data keyed by the token's operator id; screen → permission map; only the owner changes a view |
| `alerts` | Rule CRUD needs `settings:manage`; acknowledge needs the rule's `required_permission`; ack is conditional on `acknowledgedAt IS NULL` (first wins) |
| `contract-drafts` | `billing:read` / `billing:manage`, idempotent conversion, terms match `allva-api` `POST /api/v1/admin/contracts` |
| `audit` | Append-only, list format compatible with the `allva-api` trail (the web interleaves both) |

---

## 9. Database Changes

Before modifying `prisma/schema.prisma`:

```text
1. Understand the existing model and why it has no FK to product data.
2. Search all usages (repository mappers, presenters, specs).
3. Evaluate migration impact and existing data.
4. Evaluate per-operator / per-permission visibility.
5. Evaluate indexes/constraints — including the migration-only partial index.
6. Evaluate backwards compatibility with allva-backoffice-web.
7. Create a migration (`pnpm prisma migrate dev`) only when appropriate; never `db push`.
```

CI applies migrations to a clean database and runs `prisma migrate diff ... --exit-code`: schema and migration history must describe the same database. Never edit an applied migration. Never remove fields, change "enum-like" string columns (`status`, `channel`, `subject_type`…) or relations without searching every use; never ship a destructive migration silently; never use a migration to paper over a code problem.

---

## 10. External Integrations

The only live integration is **`allva-api` over HTTP**. **Never guess its behaviour** — read the controller and DTO in `../allva-api/src/modules/<area>` before changing a gateway. Check: route and version, request/response DTO, error codes passed through by `AllvaApiClient`, timeout (default 5 s), no synchronous retry chains, idempotency of writes. Never read the `allva-api` database directly; if a product endpoint is missing, it is `allva-api` backlog (see [`docs/backoffice-api.md`](./docs/backoffice-api.md) §5), not a new table here.

Any future third party (signature provider, Slack, email) needs its official documentation consulted, sandbox vs production separated, and secrets in env — never in code.

---

## 11. AI Features

None exist in this repo. Do not add model calls here without an explicit, documented decision; AI belongs to `allva-api` today.

---

## 12. Security & Isolation

Operators have no active organization: isolation here is **per permission and per operator**, not per tenant. The real sequence is:

```text
OperatorAuthGuard (Bearer → /auth/me introspection)
    → controller (extracts input, @CurrentOperator)
    → use case: permission check (assertPlatformPermission / operator.can / assertScreenAvailable)
    → ownership/visibility check (author, view owner, note visibility, rule permission)
    → domain operation (local repository and/or allva-api as the operator)
    → audit record
```

Never trust a client-sent id to establish ownership — the operator id comes from the token. `@Public()` is for health/docs only. Docs are disabled in production by default (`DOCS_ENABLED`). Never log tokens; the cache key is a hash for that reason. `TRUSTED_PROXIES` determines the IP the audit records.

---

## 13. Testing & Validation

Real commands (`package.json`, `Makefile`, `.github/workflows/ci.yml`):

```bash
pnpm prisma generate   # also runs on postinstall; required before typecheck
pnpm typecheck         # tsc --noEmit
pnpm lint:ci           # eslint src/**/*.ts, no --fix (CI). `pnpm lint` applies --fix.
pnpm test              # unit specs + test/architecture gates, no infrastructure needed
pnpm test:cov          # what CI runs
pnpm build             # nest build (DI errors are caught by application-graph.spec, not tsc)
pnpm prisma migrate deploy && pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code   # needs a clean Postgres; schema changes only
```

There is no `test:e2e` and no integration suite; specs must not open DB connections or call `allva-api`. Lint covers `src/` only. Baseline at `5f13e9b`: typecheck, lint and 12 suites / 53 tests pass. Report any check you could not run.

---

## 14. Documentation & Memory

**Update `docs/MEMORY.md` only when knowledge should survive the current task:** architectural decision, new rule or invariant, new module, new integration, structural behaviour change, permission/authorization change, audit change, a §7.3 item becoming implemented, an important limitation, a resolved `[VERIFY]` or a closed §8 decision. Not for small refactors, renames, formatting, small bugs or temporary details.

When behaviour that is documented changes, check `AGENTS.md`, `docs/MEMORY.md`, `docs/RULES.md`, `docs/ARCHITECTURE.md`, `docs/PRD.md`, [`docs/backoffice-api.md`](./docs/backoffice-api.md) and [`README.md`](./README.md); update only those affected, and do not replicate the same detail across them. A change to the `allva-api` contract or a signal key also needs the sibling repo's docs considered.

Uncertainty is written as `[VERIFY]`, never as fact:

```text
Planned ≠ Implemented        Specified in backoffice-api.md ≠ Implemented
Column exists ≠ Written      Endpoint exists ≠ Business flow complete
Documented ≠ Runtime behaviour
```

---

## 15. Definition of Done

```text
[ ] Requested behavior is implemented — all of it.
[ ] Existing architecture and layer layout were respected.
[ ] No duplicated helper/service/gateway was introduced.
[ ] No product data or FK to product data was added.
[ ] Every new/changed use case checks permission (or is justified in OWN_DATA_USE_CASES).
[ ] Per-operator / per-permission visibility remains intact.
[ ] Every new write is audited.
[ ] Database impact was evaluated; schema and migrations agree.
[ ] allva-api contracts were respected (checked in ../allva-api).
[ ] Wire formats (errors, pagination, hub signals) unchanged or deliberately versioned.
[ ] pnpm typecheck passes.
[ ] pnpm lint:ci passes.
[ ] pnpm test passes (including test/architecture).
[ ] pnpm build passes when bootstrap/config/modules changed.
[ ] Documentation was updated when necessary.
[ ] MEMORY.md was updated if a persistent decision was introduced.
[ ] No known part of the requested task was silently skipped.
```

Delivering 40–60 % of a task is not done. Otherwise report:

```text
Completed:
...
Not completed:
...
Blocked by:
...
Needs verification:
...
```

---

## 16. Forbidden Behaviors

### Never:

- start implementing before inspecting the affected code;
- invent architecture, endpoints, permissions or existing functionality;
- duplicate an existing service/helper/gateway without searching;
- store product data here, add an FK to product data, or read the `allva-api` database;
- copy the role → permission matrix or decide anything by role;
- put authorization in a route guard, or add a use case without an access decision;
- bypass per-operator / per-permission visibility, or trust client ids for ownership;
- call `allva-api` with any credential other than the operator's bearer;
- remove or bypass auditing of a write, or add an update/delete path to the audit log;
- weaken a `test/architecture/` gate to make code pass;
- silently change API contracts, signal keys or database behaviour;
- introduce destructive migrations without justification;
- guess third-party (including `allva-api`) behaviour;
- expose secrets, log tokens or hardcode credentials;
- point `deploy.yml` at `allva-backend`, `allva/backend` or the product's `DATABASE_URL` — every deploy target is the backoffice's own (`allva-backoffice-api`, `BACKOFFICE_*` secrets);
- present planned functionality (§7.3) as implemented;
- mark work complete when requirements remain unfinished;
- modify unrelated parts of the project without a clear reason;
- overwrite deliberate decisions merely because another approach looks simpler.

---

## 17. Quick Reference

| Need | Go to |
|---|---|
| Ownership split, endpoint contract, open decisions | [`docs/backoffice-api.md`](./docs/backoffice-api.md) (§1, §4, §8) |
| Permission check | `src/modules/auth/application/platform-authorization.ts` |
| Permission vocabulary | `src/modules/auth/domain/platform-permissions.ts` |
| Current operator | `@CurrentOperator()`, `src/modules/auth/domain/entities/operator.entity.ts` |
| Audit a write | `src/modules/audit/application/backoffice-audit-log.service.ts` |
| Call allva-api | port in `domain/ports/` + gateway in `infrastructure/providers/` over `src/shared/infrastructure/allva-api/allva-api.client.ts` |
| Env | `src/shared/infrastructure/config/env.ts`, `.env.example` |
| Pagination | `src/shared/domain/repositories/pagination.ts`, `src/shared/infrastructure/http/pagination/page-query.dto.ts` |
| Architecture gates | `test/architecture/` |
| Schema | `prisma/schema.prisma`, `prisma/migrations/` |

Before significant work:

1. Read `docs/MEMORY.md`
2. Read `docs/RULES.md`
3. Check `docs/ARCHITECTURE.md`
4. Inspect the affected code
5. Inspect tests
6. Check Prisma when applicable
7. Implement the smallest correct change
8. Validate
9. Update docs/memory if necessary

When in doubt: **Do not guess. Investigate.**
