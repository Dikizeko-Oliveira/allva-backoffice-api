# Allva Backoffice API — Project Memory

> Persistent context for developers and AI agents working on the internal-process backend.
> **Last audited against the code:** 2026-10-16, branch `main`, commit `5f13e9b`.

See also: [Agent Instructions](../AGENTS.md) · [Product Requirements](./PRD.md) · [Architecture](./ARCHITECTURE.md) · [Engineering Rules](./RULES.md) · [Specification](./backoffice-api.md)

Status markers: `[IMPLEMENTED]` `[PARTIAL]` `[PLANNED]` `[DECISION]` `[CONSTRAINT]` `[DEPRECATED]` `[VERIFY]`

---

## 1. How to Use This File

- Read the sections relevant to your task **before** architectural, cross-module, authorization, data-model, integration or infrastructure work.
- This file records **why** things are the way they are and what is easy to get wrong. *How* the system is built is in [ARCHITECTURE.md](./ARCHITECTURE.md); *what you must and must not do* is in [RULES.md](./RULES.md).
- Code wins over this file. If they disagree, verify in code, then fix this file.
- `[VERIFY]` means not confirmed from this repository. Never promote it to fact without checking.

---

## 2. Project Identity

- **Name:** `@allva/backoffice-api` (`allva-backoffice-api`), version `0.1.0`, private.
- **Role:** backend of the **internal process** of the Allva team. Not the product.
- **Created:** 2026-09-23 (`43002ab` first commit; `769b3b3` restructured into clean architecture with its own database; `5f13e9b` SLA filter on the queue).
- **Origin of the design:** [`backoffice-api.md`](./backoffice-api.md), written on 2026-09-22 from the real state of `allva-api`, which ideated from [`workspace-screen.md`](./workspace-screen.md).
- **Siblings:**
  - `allva-api` — product backend; owns all product data **and the platform RBAC matrix** (`../allva-api/src/modules/accounts/domain/platform-rbac.ts`). Issues tokens.
  - `allva-backoffice-web` — operator panel (Next.js, port 3001); calls both APIs through its BFF.
- **Local ports:** API `8081`, own Postgres `5433` (the product's is usually `5432`).

---

## 3. Product Context

Allva is an **Evidence-based Ads Intelligence** platform. Allva staff ("operators") run the customer base through `allva-backoffice-web`. Most of what they see is product data served by `allva-api`. This service stores only what makes sense **for the Allva team itself**: who answered a ticket and how fast, what was noted about a customer, which views an operator saved, which internal alerts fired, which contract terms are being negotiated, and the audit trail of those writes.

`[DECISION]` **Ownership test:** *if the customer disappeared tomorrow, would the data still make sense?* Only for the Allva team ⇒ here. Describes the customer or what they bought ⇒ `allva-api`. Putting internal process in `allva-api` would couple the product to how the team works: changing an escalation rule would need a migration on the customer database.

---

## 4. Architecture Snapshot

```text
allva-backoffice-web (BFF, server side)
   │ Bearer <operator token from allva-api>
   ▼
allva-backoffice-api ── OperatorAuthGuard ── GET /api/v1/auth/me ──► allva-api
   │  controller → use case (authorization) → ports
   ├── Prisma ──► allva_backoffice_db (own Postgres)
   └── gateways ──► allva-api (as the operator: tickets, contracts)
```

Eight layered modules + `health` (flat). Detail in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 5. Technology Stack

NestJS 11 · TypeScript 5.9 · Prisma 7.3 (`prisma-client` generator → `generated/prisma`, `@prisma/adapter-pg`) · PostgreSQL 15 · zod 4 (env) · class-validator · helmet · Swagger + Scalar · Jest 29 · pnpm 8.15.5 · Node 22 · Docker · GCP Cloud Run (deploy on push to `main`).

---

## 6. Authentication

- `[DECISION]` **Introspection, not local JWT validation.** Every request is resolved through `GET {ALLVA_API_URL}/api/v1/auth/me` with the operator's bearer. Local validation would be faster but would lose what only `allva-api` knows: **revoked sessions and role changes**. A demoted operator would keep their old power until the token expired (7 days by default, per the spec).
- `[DECISION]` Short cache (≤ 60 s, `OPERATOR_INTROSPECTION_CACHE_MS`, capped by zod), keyed by **SHA-256 of the token** (the map never stores credentials). Only **conclusive** answers are cached (operator / not-operator); a 401 or an outage is not.
- `[DECISION]` **Fail closed:** invalid token ⇒ `401 UNAUTHORIZED`; customer account or incomplete `/auth/me` payload ⇒ `403 ACCOUNT_NOT_AUTHORIZED` (`details.permission: 'platform'`); `allva-api` unreachable ⇒ `503 IDENTITY_INTROSPECTION_FAILED`. A dependency failure is not a logout.
- `[CONSTRAINT]` This service issues no token and stores no password. The operator id (`account.id` of the product) is the identifier in every column here, without FK.

---

## 7. Authorization & Platform RBAC

- `[DECISION]` **The matrix lives only in `allva-api`.** `PLATFORM_PERMISSIONS` here is vocabulary so the compiler rejects `'billing:reed'`; it filters nothing at runtime. A copied matrix diverges at the first new permission, and a stale guard keeps answering `200` silently.
- `[DECISION]` **Permission, never role.** `can('support:manage')`, never `role === 'ALLVA_SUPPORT'`. Five roles exist in `allva-api` (`ALLVA_ADMIN`, `ALLVA_OPERATOR`, `ALLVA_SUPPORT`, `ALLVA_FINANCE`, `ALLVA_SALES`); nothing here depends on them.
- `[DECISION]` **Authorization lives in the use case**, as in `allva-api`, so a second caller (another route, a future job) cannot escape it. The global guard only authenticates. The cost — forgetting is silent — is paid by the `authorization.spec.ts` gate.
- `[DECISION]` **New permission is born in `allva-api`** (matrix row per role + boundary test), then added here.
- `[DECISION]` Refusal shape is the product's: `{ code: 'ACCOUNT_NOT_AUTHORIZED', message, details: { permission } }`.
- `[DECISION]` **Hidden means absent:** a note the operator cannot see, or a saved-view screen they lack, answers `404` — saying "exists but forbidden" already leaks that something was written there.

---

## 8. Operations Hub

- `[IMPLEMENTED]` `GET /api/v1/hub/attention` returns the internal half of the hub's "Requires attention".
- `[DECISION]` **Same shape as `allva-api` `GET /api/v1/admin/attention`** so the web concatenates both lists without special cases. Signals carry the **permission**, not the area: grouping into areas is navigation, owned by the web. Returning "Billing & Finance" would make moving a menu item a backend deploy.
- `[DECISION]` **No server-side composition.** There must be no `GET /api/v1/hub` here that calls `allva-api` and returns everything: a slow `allva-api` would become a slow backoffice-api and both would fall together. The web calls both in parallel.
- `[DECISION]` Each count runs isolated; one failing query yields `count: null` for that signal, never a blank hub.
- Signal keys are a contract with the web (`../allva-backoffice-web/src/modules/platform/signals.ts`). Unknown keys are ignored by the web.

---

## 9. Support (SLA, queue, assignment, metrics)

- `[DECISION]` The ticket, its messages, status, priority and **current assignee** live in `allva-api`. Here: SLA snapshot, assignment history with reason, policies, metrics.
- `[DECISION]` **Deadlines are fixed when the ticket is first seen**, from the policy in force then; `observe` never recomputes them. Changing a policy tomorrow must not turn an old ticket into "breached".
- `[DECISION]` First operator reply is a historical fact — once recorded, never changes. Reopened ticket ⇒ `resolvedAt` cleared, resolution deadline runs again. Closed ticket is never breached.
- `[DECISION]` Policies are configuration: read `support:read`, write `settings:manage`. **One active policy per (priority, category) scope**, enforced by the partial unique index `sla_policies_one_active_per_scope` (migration only — Prisma cannot express it) and pre-checked in code to answer `409 SLA_POLICY_SCOPE_TAKEN` instead of a `500`.
- `[DECISION]` `FALLBACK_SLA_TARGETS` apply when no policy matches, so the queue always has deadlines (CRITICAL 30 min / 4 h … LOW 24 h / 5 d).
- `[DECISION]` **Queue pagination:** without `sla`, filters and paging go to `allva-api` and SLA only reorders inside the page. With `sla` (`BREACHED`/`AT_RISK`/`ON_TRACK`), the use case scans up to `MAX_TICKETS_SCANNED_FOR_SLA_FILTER` (5 × 100) tickets, computes SLA, filters and paginates locally. Do **not** switch this to reading `ticket_sla_snapshots` until periodic polling exists — today the table only contains tickets someone has already opened.
- `[DECISION]` **Assignment:** written in `allva-api` first (`PATCH /api/v1/admin/support/tickets/:id`, which validates the assignee); only on success the event is stored here. Reassigning a ticket that already had an owner requires `reason` (`400 ASSIGNMENT_REASON_REQUIRED`).

---

## 10. Internal Notes, Preferences, Alerts, Contract Drafts

- `[DECISION]` **Note permission follows the subject:** `ORGANIZATION`→`orgs:read`, `ACCOUNT`→`users:read`, `SALES_LEAD`→`leads:read`, `CONTRACT`→`billing:read`. Writing needs the same permission as reading — annotating does not change the customer. `visibilityPermission` restricts further, and an author cannot restrict to a permission they lack (they could not read it back). Edit/delete: author or `settings:manage`. Delete is soft (`deletedAt`) so audit rows keep pointing at an existing note.
- `[DECISION]` Notes never reach the product — that is what separates them from a column in `organizations`. Ticket-internal notes are ticket messages and stay in `allva-api`.
- `[DECISION]` Preferences are the operator's own data (id from the token, no permission). Saved views: only the owner changes them; `shared` shows them to colleagues who hold the screen's permission (`SCREEN_PERMISSION`), and a view of a screen the operator lost disappears from their list. `filters`/`columns`/`sort` are opaque — the screen owns their format.
- `[DECISION]` Alerts: `allva-api` produces the fact; deciding **who wakes up** is here. `required_permission` on the rule decides who sees and acknowledges an event. Acknowledgement is first-wins (conditional on `acknowledgedAt IS NULL`).
- `[DECISION]` **Contract drafts live here** because until signature they are sales negotiation. `EnterpriseContract` in `allva-api` is born `SIGNED`. Conversion calls `POST /api/v1/admin/contracts` and stores `contractId`; it is idempotent and a converted draft is locked (`409 CONTRACT_DRAFT_ALREADY_CONVERTED`). **The signed PDF is product data** and is never stored here.

---

## 11. Audit

- `[DECISION]` Every internal write records `backoffice_audit_logs` through `BackofficeAuditLogService`. Same contract as `allva-api`'s `AuditLogService`: **recording never breaks the operation**; a failure is logged with what identifies the lost row.
- `[DECISION]` Append-only. No update or delete path exists.
- `[DECISION]` `GET /api/v1/audit-logs` (`audit:read`) uses an item format compatible with the product trail (`source: 'BACKOFFICE'`) so the web interleaves both by `createdAt`.
- Note: for internal notes the audit `subjectType`/`subjectId` are the **note's subject** (e.g. the organization), not the note id.

---

## 12. Infrastructure

- `[DECISION]` **Own database**, separate migration history. Sharing `_prisma_migrations` with the product would make `migrate dev` in one repo ask for a reset because of the other.
- `[DECISION]` CI applies migrations with `migrate deploy` (never `db push`) to a clean Postgres and fails if `prisma migrate diff` finds drift.
- `[DECISION]` **Deploy runs on push to `main` (and `workflow_dispatch`), with everything named for the backoffice.** It was manual-only from 2026-09-23 because `deploy.yml` had been copied from `allva-api` pointing to the product service, image and `DATABASE_URL`: a push would have **replaced the product backend** and run these migrations on the customer database. The trigger came back (2026-10-20) once every target was the backoffice's own: service `allva-backoffice-api`, job `allva-backoffice-api-migrate`, image `allva/backoffice-api`, runtime SA `allva-backoffice-api@`, secrets `BACKOFFICE_DATABASE_URL` / `BACKOFFICE_ALLVA_API_URL`. **Never point any of these back at `allva-backend`, `allva/backend` or `DATABASE_URL`.**
- `[DECISION]` GCP resources are created by `scripts/gcp/provision.sh` (idempotent; never regenerates the DB password if the secret already has a version). The database is a **separate database** (`allva_backoffice_db`, own user) on the Cloud SQL instance `allva-postgres-staging` `[VERIFY]` — a dedicated instance is the alternative if hard isolation or independent maintenance windows are wanted (`CLOUDSQL_INSTANCE=...` in the script). Reaches the instance by private IP through the VPC, like `allva-api`.
- `[DECISION]` **No custom domain**: the Cloud Run `*.run.app` URL is the official one; the deploy prints it in the run summary and smoke-tests `GET /api/v1/health` (database only) after each deploy.
- `[DECISION]` GitHub auth is Workload Identity Federation with the **same** deploy service account and provider as `allva-api`; this repo only needs its own copy of the secrets `GCP_WIF_PROVIDER` and `GCP_DEPLOY_SERVICE_ACCOUNT`, and the provider/SA must trust `Dikizeko-Oliveira/allva-backoffice-api`. The provider (`github-pool/github-provider`) filters by **`repository_id`**, not by name: every new repo that deploys needs its numeric id appended to the attribute condition (never replaced — the existing ids belong to the other Allva repos), plus a `workloadIdentityUser` binding on `github-deployer@`. A missing id fails as `unauthorized_client: rejected by the attribute condition`.
- `[VERIFY]` The first migration on Cloud SQL PostgreSQL 15 runs as a non-superuser (`allva_backoffice`); if it fails with `permission denied for schema public`, grant `ALL ON SCHEMA public` on `allva_backoffice_db` to that user as `postgres`. Not yet exercised against Cloud SQL (verified locally against Postgres 15 with the production image).
- `[DECISION]` Health checks **only the own database**. `allva-api` down fails dependent routes with an explained `503`, but is no reason to take this instance out of rotation.
- `[DECISION]` `configureApp` lives outside `main.ts` so tests can exercise the real request pipeline (a false `500` was once reported because a harness booted `AppModule` without the guard).

---

## 13. Security Decisions

- Product calls run **as the operator** (their bearer). This service has no credential of its own and never acts with more power than whoever clicked.
- `X-Correlation-Id` is honoured (≤ 200 chars) or generated, and propagated to `allva-api`.
- `TRUSTED_PROXIES` is a trust boundary: it decides the IP the audit records. Prefer the address list form in production.
- Docs (`/docs`, `/docs-json`, `/scalar`) are off in production unless `DOCS_ENABLED=true`. Strict CSP on the JSON surface; CORS allowlist enforced only in production.
- Validation pipe is `whitelist` + `forbidNonWhitelisted`: unknown fields are a `400 VALIDATION_ERROR`.

---

## 14. Important Historical Decisions

| Date | Commit | Decision |
|---|---|---|
| 2026-09-22 | — | Spec [`backoffice-api.md`](./backoffice-api.md) defines the three-piece split and buckets C1–C6 |
| 2026-09-23 | `769b3b3` | Clean architecture mirroring `allva-api`; raw-SQL controllers removed; own DB; authorization in use cases; `/api/v1`; zod env; architecture gates; deploy made manual |
| 2026-09-23 | `769b3b3` | Bugs fixed in that pass: queue erased who spoke last; `resolvedAt` changed on every read; closed ticket stayed breached forever; converted draft was editable; concurrent alert acknowledgement overwrote |
| 2026-09-23 | `5f13e9b` | `sla` filter on the queue (the hub already linked to `/support?sla=BREACHED`) |
| 2026-10-20 | — | Deploy on push to `main` with own GCP resources (`scripts/gcp/provision.sh`); CI builds the image; image runs as non-root; post-deploy smoke test |

---

## 15. Decisions That Should Not Be Accidentally Reversed

1. Own database; product references are opaque ids without FK; never read `allva_db`.
2. Identity via `/auth/me` introspection; cache ≤ 60 s; fail closed.
3. RBAC matrix only in `allva-api`; permission, never role.
4. Authorization inside the use case, enforced by `test/architecture/authorization.spec.ts`.
5. Product calls with the operator's bearer only.
6. Audit never breaks the operation; audit is append-only.
7. Hub has the product's shape, carries permissions not areas, and is not composed server-side.
8. SLA deadlines fixed at first sight; first reply immutable.
9. One active SLA policy per scope (migration-only partial index + `409`).
10. Queue `sla` filter scans the product, not the snapshot table, until polling exists.
11. Signed contract PDF belongs to `allva-api`.
12. Hidden ⇒ `404`.
13. Deploy targets only `BACKOFFICE_*` / `allva-backoffice-api` resources — never the product's service, image or `DATABASE_URL`.

---

## 16. Known Technical Debt

- Only ticket assignment passes `ip`/`userAgent` to the audit; every other write records them as `null`.
- Assignment: if the local event write fails after `allva-api` accepted the change, the use case throws; nothing reconciles (spec §4.1.1 asks for log + reconcile) `[VERIFY]` intended behaviour.
- Contract draft `status` is a free string (≤ 50 chars), not the spec's `DRAFT | SENT_FOR_SIGNATURE | SIGNED | ABANDONED`; `terms` is only `@IsObject()` — validated by `allva-api` only at conversion.
- Alert rule `source`, `threshold` and `quietHours` are stored unvalidated (nothing evaluates them yet).
- Several saved views may be `isDefault` on the same screen.
- Introspection cache is per process (not shared across instances).
- `PrismaService` uses SSL with `rejectUnauthorized: false` for any non-`localhost` URL.
- `PLATFORM_PERMISSIONS` is synced with `allva-api` by hand.
- `pnpm lint` / `lint:ci` cover `src/` only, not `test/`.

---

## 17. Known Limitations

- **SLA snapshots update only on read** (queue, ticket detail, assignment). Hub counts therefore cover only tickets someone has already opened; a breached ticket nobody looked at is not counted.
- `support.escalated` is always `0`: no code writes `escalated_*`.
- `alerts.unacknowledged` is effectively always empty: nothing creates `AlertEvent` rows. When its query fails it returns no signal rather than `count: null` — a deviation from the hub rule `[VERIFY]`.
- `businessHours` is stored on policies but **ignored**: deadlines run in calendar minutes.
- Metrics return `null` for median/p90 first response and resolution and for resolved/reopened volume. Filtering by another operator requires only `support:read` (spec says `support:manage`) `[VERIFY]`.
- `allva-backoffice-web` consumes only hub attention, the queue, ticket detail, assignment and audit logs. Notes, preferences/views, alerts, alert rules, drafts, SLA policies and metrics have no UI yet `[VERIFY]` against the web repo.
- [`backoffice-api.md`](./backoffice-api.md) §3 still marks `GET /api/v1/hub/attention` as "A criar"; it exists. The copy in `allva-api/docs/` writes routes without `/api/v1`.

---

## 18. Planned / Not Yet Implemented

- `[PLANNED]` Ticket polling job (every 1–2 min, watermark on `lastMessageAt`) — prerequisite for reading SLA state from snapshots.
- `[PLANNED]` Escalation job (every 5 min) writing `escalated_at` / `escalated_to` and generating alerts.
- `[PLANNED]` Alert evaluation job reading both `attention` endpoints, deduplicating, sending `EMAIL` / `SLACK`.
- `[PLANNED]` Service credential for jobs — needs a service platform role in `allva-api` first (spec §8.4). Never reuse a human operator's token or an `ALLVA_ADMIN` account.
- `[PLANNED]` Per-operator rate limit on write routes.
- `[PLANNED]` Signature-provider webhook writing to drafts; after signature, sending the PDF to `allva-api` `POST /api/v1/admin/contracts/:id/signed-document`.
- `[PLANNED]` Business-hours calendar for SLA.
- Open decisions owned by product/`allva-api` (spec §8): role granularity, multiple roles per account, "lookup" permissions per area, service role, outbound events from `allva-api`.

---

## 19. Common Pitfalls

- `generated/prisma` is git-ignored: run `pnpm prisma generate` (postinstall does) before `typecheck`.
- `prisma migrate deploy` needs `prisma.config.ts` — the schema has no inline `url` (driver adapter pattern).
- Specs need `DATABASE_URL` and `ALLVA_API_URL` only to satisfy `EnvModule`; `test/support/test-env.ts` sets throwaway defaults. No spec may open a connection.
- `pnpm build` is `tsc`: an unregistered provider compiles. `application-graph.spec.ts` is what catches it.
- A new use case without an access check fails CI — add the check, do not add it to `OWN_DATA_USE_CASES` unless it truly serves the operator's own data.
- Literal `'ALLVA_*'` strings anywhere in `src/` (outside comments) fail the role gate.
- `@Controller()` must carry the full `/api/v1/...` path; there is no global prefix.
- An `allva-api` error passes through with its status and body; a network failure becomes `503 PRODUCT_API_UNAVAILABLE`.
- The partial index lives only in the migration SQL. When editing `SlaPolicy`, make sure a generated migration does not drop it.

---

## 20. Important Files & Entry Points

| Concern | File |
|---|---|
| Bootstrap / pipeline | `src/main.ts`, `src/configure-app.ts`, `src/app.module.ts` |
| Env | `src/shared/infrastructure/config/env.ts` |
| Authentication | `src/modules/auth/infrastructure/http/guards/operator-auth.guard.ts`, `.../providers/allva-api-operator-identity.gateway.ts` |
| Authorization | `src/modules/auth/application/platform-authorization.ts`, `src/modules/auth/domain/platform-permissions.ts` |
| Audit | `src/modules/audit/application/backoffice-audit-log.service.ts` |
| allva-api transport | `src/shared/infrastructure/allva-api/allva-api.client.ts` |
| SLA rules | `src/modules/support/domain/sla.ts`, `.../entities/ticket-sla-snapshot.entity.ts`, `.../services/ticket-sla-tracker.service.ts` |
| Hub | `src/modules/operations-hub/domain/attention-signals.ts`, `.../attention-counts-prisma.reader.ts` |
| Gates | `test/architecture/*.spec.ts` |
| Schema | `prisma/schema.prisma`, `prisma/migrations/` |
| CI / deploy | `.github/workflows/ci.yml`, `.github/workflows/deploy.yml` |

---

## 21. Glossary

| Term | Meaning |
|---|---|
| Operator | Allva staff account with a platform role; represented per request by `Operator`, never persisted |
| Platform permission | Capability string like `support:manage`, resolved by `allva-api` |
| Introspection | Resolving a bearer through `allva-api` `GET /api/v1/auth/me` |
| Opaque id | Reference to a product record, stored without FK |
| Attention signal | `{ key, permission, severity, count }` item of the hub |
| SLA snapshot | `ticket_sla_snapshots` row: what this service knows about a product ticket |
| Scope (SLA) | Priority + optional category of a policy |
| Subject (notes) | The product record a note is about |
| Draft conversion | Creating the real contract in `allva-api` from a draft |
| C1–C6 | Spec buckets: support process, notes, preferences, alerts, metrics, drafts |

---

## 22. Memory Maintenance Rules

Update this file when knowledge must survive the current task: architectural decision, new rule or invariant, new module, new integration, structural behaviour change, permission/authorization change, audit change, a planned item becoming implemented, an important limitation, a resolved `[VERIFY]`, a closed spec §8 decision. Not for refactors, renames, formatting, small bugs or temporary details. Not a changelog. Never record planned work as implemented. Update the "Last audited" line when you re-audit.
