# Allva Backoffice API — Engineering Rules

> Rules and invariants for changing `allva-backoffice-api`. Reasons live in [MEMORY.md](./MEMORY.md); the structure in [ARCHITECTURE.md](./ARCHITECTURE.md).
> **Last audited against the code:** 2026-10-16, branch `main`, commit `5f13e9b`.

See also: [Agent Instructions](../AGENTS.md) · [Product Requirements](./PRD.md) · [Architecture](./ARCHITECTURE.md) · [Project Memory](./MEMORY.md)

**MUST / MUST NOT** = invariant. **SHOULD** = default unless justified in the PR. **[GATE]** = enforced by `test/architecture/` and fails `pnpm test`.

---

## 1. Purpose

This service stores Allva's internal process and reads product data on behalf of operators. The rules below protect three things: **who may see and do what**, **which database owns which data**, and **the audit trail**.

---

## 2. Engineering Principles

1. Investigate first: controller → use case → port → repository/gateway → `allva-api` controller and DTO.
2. Reuse the existing pattern of the nearest module; do not invent a new shape.
3. Smallest correct change; no unrelated refactors.
4. Rules that matter get a test; structural rules get a gate.
5. Never claim a capability the code does not have — write `[VERIFY]`.

---

## 3. Source of Truth

(1) source code, (2) `prisma/schema.prisma` + migrations, (3) tests, (4) runtime config (`env.ts`, `configure-app.ts`, `Dockerfile`, workflows), (5) [ARCHITECTURE.md](./ARCHITECTURE.md), (6) [MEMORY.md](./MEMORY.md), (7) [PRD.md](./PRD.md) and [`backoffice-api.md`](./backoffice-api.md) (specification, partly unbuilt), (8) [`workspace-screen.md`](./workspace-screen.md) (ideation; names are illustrative).

---

## 4. Project Structure

- Every module except `health` **MUST** have `domain/`, `application/`, `infrastructure/`. **[GATE]**
- New flat modules **MUST NOT** be added without a documented reason (`FLAT_MODULES` in `layering.spec.ts`).
- Shared, cross-cutting code goes to `src/shared/`; module-specific code stays in its module.

---

## 5. Module Boundaries & Layers

- `domain/` **MUST NOT** import `application/`, `infrastructure/`, `@nestjs/common`, `@nestjs/core`, `@prisma/client`, `express` or `generated/`. **[GATE]**
- `application/` **MUST NOT** import any module's `infrastructure/`. **[GATE]**
- Only `infrastructure/` (and flat `health`) **MAY** touch `PrismaService` or `generated/`. **[GATE]**
- Every port **MUST** be an `abstract class` in `domain/ports/`. **[GATE]**
- Cross-module imports **SHOULD** be limited to `auth/domain`, `auth/application`, `audit/application`, `auth/infrastructure/http/decorators` and pure `domain/` rules. A use case **MUST NOT** call another module's repository.

---

## 6. Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Use case | `<verb>-<noun>.usecase.ts`, class `<Verb><Noun>UseCase` | `assign-support-ticket.usecase.ts` |
| Port | `<noun>.repository.ts` / `.gateway.ts` / `.reader.ts`, class `…Interface` | `SupportTicketsGatewayInterface` |
| Prisma adapter | `<noun>-prisma.repository.ts` / `-prisma.reader.ts` | `sla-policies-prisma.repository.ts` |
| HTTP gateway | `allva-api-<noun>.gateway.ts` | `allva-api-contracts.gateway.ts` |
| DTOs | `*InputDto`, `*OutputDto`, `*QueryDto` in `application/dtos/` | `ListSupportQueueQueryDto` |
| Presenter | `to<Entity>Output` in `application/<module>.presenter.ts` | `toInternalNoteOutput` |
| Access helper | `application/<noun>-access.ts` | `note-access.ts` |
| Audit action | `<subject>.<verb_past>` in snake case | `contract_draft.converted` |
| Error code | `SCREAMING_SNAKE_CASE` | `SLA_POLICY_SCOPE_TAKEN` |

Code comments are in pt-BR and record the *why*; keep that density.

---

## 7. Controllers

- **MUST** declare the full route in `@Controller('/api/v1/...')`; no bare `@Controller()`, no global prefix. **[GATE]**
- **MUST** be thin: extract input (`@CurrentOperator()`, DTOs, params), call **one** use case, return its result.
- **MUST NOT** contain authorization, business rules, Prisma or `AllvaApiClient`.
- **SHOULD** carry `@ApiTags`, `@ApiBearerAuth()`, `@ApiOperation` stating the required permission and notable error codes.

---

## 8. Use Cases & Services

- Every use case **MUST** decide access: `assertPlatformPermission`, `assertScreenAvailable`, or `operator.can(...)` / `operator.permissions` filtering. **[GATE]**
- `OWN_DATA_USE_CASES` **MUST** stay a ceiling: an entry needs a reason and must be data of the calling operator only. **[GATE]** for staleness.
- A use case **MUST** stay under 150 significant lines. **[GATE]** Extract a helper (`find-*.ts`, `*-access.ts`) or application service instead.
- `now` **SHOULD** be a parameter (default `new Date()`) wherever time matters, so rules are testable.
- Application services (e.g. `TicketSlaTrackerService`) are for logic shared by several use cases of the **same** module.

---

## 9. DTOs & Validation

- Every input **MUST** be a class-validator DTO. Lists **MUST** extend `PageQueryDto` (never redeclare `page`/`pageSize`).
- Strings **MUST** have `@MaxLength`. Values from a closed set **MUST** use `@IsIn(<as const array>)`.
- `null` meaning "clear" uses `@ValidateIf((_, v) => v !== null)`; `undefined` means "do not touch".
- The global pipe rejects unknown fields (`forbidNonWhitelisted`); **MUST NOT** be relaxed.
- Responses **MUST** go through a presenter to an `*OutputDto`; never return entities or Prisma records.

---

## 10. Prisma & Database

- **MUST** use this service's own database only. **MUST NOT** connect to, read from or add a datasource for `allva_db`.
- Product references **MUST** be opaque string ids **without FK**. Orphans are handled on read; **MUST NOT** cascade-delete by inference.
- **MUST NOT** store product data (customer attributes, contract PDFs, invoice state, ticket messages…). Consume `allva-api` instead.
- Closed value sets are `String` columns validated in TypeScript; changing one **MUST** include a search of every use (entity arrays, DTO `@IsIn`, presenters, specs, the web).
- Constraints Prisma cannot express (partial/expression indexes) live in the migration SQL with a comment in `schema.prisma`; **MUST NOT** be dropped by a generated migration.

---

## 11. Transactions

There is no `$transaction` usage today. A write that spans this database and `allva-api` cannot be atomic: the product write happens first and the local write after it (assignment, conversion). New flows **MUST** follow the same order and **MUST** be idempotent or reconcilable on the local side.

---

## 12. Authentication

- Identity **MUST** come from `allva-api` `GET /api/v1/auth/me` via `OperatorIdentityGatewayInterface`. **MUST NOT** validate JWTs locally, issue tokens or store passwords.
- `OPERATOR_INTROSPECTION_CACHE_MS` **MUST NOT** exceed 60 000 (zod enforces it). Only conclusive results are cached; the key is a hash of the token.
- Failures **MUST** fail closed: 401 / 403 / 503 as in `AuthenticateOperatorUseCase`. **MUST NOT** allow while `allva-api` is down.
- `@Public()` is for health and docs only.

---

## 13. Authorization

- Authorization **MUST** live in the use case. The guard **MUST NOT** check permissions.
- **MUST** decide by permission. **MUST NOT** compare `platformRole` or use `'ALLVA_*'` literals. **[GATE]**
- **MUST NOT** add a role → permission map. `PLATFORM_PERMISSIONS` is vocabulary only.
- A new permission **MUST** exist in `allva-api` (`platform-rbac.ts` + spec) before it is added here.
- Refusals **MUST** use `assertPlatformPermission` / `platformPermissionDenied` (`403 ACCOUNT_NOT_AUTHORIZED`, `details.permission`).
- Something the operator may not see **SHOULD** answer `404` (notes, saved-view screens), not `403`.

---

## 14. Isolation (permission and operator)

- The operator id **MUST** come from the token (`Operator.id`), never from the body/query, for ownership (preferences, views, authorship, audit actor).
- Shared data **MUST** be filtered by the permission that guards it (subject, screen, rule, signal) on every read path, including lists and hub counts.
- A restriction an operator sets (note `visibilityPermission`, alert `requiredPermission`) **MUST** be one they hold, when the code already enforces that (notes).

---

## 15. `allva-api` Integration

- Every call **MUST** go through a port in `domain/ports/` and a gateway in `infrastructure/providers/` over `AllvaApiClient`. **MUST NOT** inject `AllvaApiClient` into a use case or call `fetch` elsewhere.
- Every call **MUST** use the operator's bearer (`operator.accessToken`). **MUST NOT** use any other credential until a service role exists in `allva-api`.
- **MUST** check the controller and DTO in `../allva-api` before changing a path, payload or mapping. **MUST NOT** guess behaviour.
- **MUST** keep timeouts and **MUST NOT** add synchronous retry chains.
- A missing product endpoint is `allva-api` backlog; **MUST NOT** replace it with a local table.
- Future third parties (signature, Slack, email) **MUST** be ports + providers, credentials from env, sandbox separated from production.

---

## 16. Auditability

- Every write use case **MUST** call `BackofficeAuditLogService.record` after the change, with `before`/`after` where meaningful and `reason` when the flow has one.
- New write flows **SHOULD** pass `ip` and `userAgent` from the controller (`request.ip`, `user-agent`) as assignment does.
- **MUST NOT** let an audit failure fail the operation; **MUST NOT** add update/delete to the audit log.

---

## 17. Error Handling

- Errors **MUST** be `HttpException`s with `{ code, message, details? }`, code in `SCREAMING_SNAKE_CASE`.
- Upstream `allva-api` errors pass through unchanged; dependency failure is `503`, unexpected upstream payload `502`.
- **MUST NOT** leak internals in `500` responses in production (the filter handles it — do not bypass it).

---

## 18. Logging

- Use Nest `Logger` with the class name. **MUST NOT** log tokens, `Authorization` headers or note bodies.
- Degraded paths (failed hub count, failed audit) **SHOULD** log a warning/error that identifies what was lost.

---

## 19. Security

- **MUST NOT** weaken helmet/CSP/CORS in `configure-app.ts` without a documented reason.
- **MUST NOT** hardcode secrets; `.env` is git-ignored, `.env.example` holds safe local values only.
- `TRUSTED_PROXIES` changes **MUST** be treated as audit-affecting.

---

## 20. Environment Variables

- Every variable **MUST** be declared in `envSchema`. Module code **SHOULD** read it through `EnvService`. Today `main.ts`, `configure-app.ts`, `docs-visibility.ts`, `PrismaService` and `GlobalExceptionFilter` read `process.env` directly; do not spread that further.
- A new required variable **MUST** be added to `.env.example`, `test/support/test-env.ts` (if `AppModule` needs it), `.github/workflows/ci.yml` and `deploy.yml` secrets.

---

## 21. Testing

- Specs **MUST NOT** open a DB connection or call `allva-api`; use fakes of the ports.
- Pure rules **SHOULD** be tested in `domain/`; non-trivial use cases with a co-located spec.
- A new structural rule **SHOULD** become a gate in `test/architecture/`. **MUST NOT** weaken a gate to pass.
- Before declaring done: `pnpm typecheck`, `pnpm lint:ci`, `pnpm test`; `pnpm build` when bootstrap/modules change; migrations check when the schema changes ([ARCHITECTURE.md §19](./ARCHITECTURE.md#19-build--deployment)).

---

## 22. Backwards Compatibility

- Response shapes, error codes, hub signal keys and the hub format are contracts with `allva-backoffice-web`. **MUST NOT** change silently; check the web's services and `signals.ts`.
- The hub format **MUST** stay identical to `allva-api` `GET /api/v1/admin/attention`.

---

## 23. Migrations

- Create with `pnpm prisma migrate dev`; apply with `migrate deploy`. **MUST NOT** use `db push`.
- **MUST NOT** edit an applied migration. Destructive changes (drop column/table, type narrowing) **MUST** be explicit and justified in the PR.
- `prisma migrate diff --exit-code` in CI **MUST** pass: schema and history describe the same database.

---

## 24. Deployment

- `deploy.yml` runs on push to `main` and `workflow_dispatch`. Its targets **MUST** be the backoffice's own resources (`allva-backoffice-api` service, `allva-backoffice-api-migrate` job, `allva/backoffice-api` image); it **MUST NOT** name the product's `allva-backend`.
- GCP resources are created with `scripts/gcp/provision.sh`, not by hand; a change to what the deploy needs updates the script too.
- Service and migrate job **MUST** use `BACKOFFICE_*` secrets, never the product's.

---

## 25. Documentation

Update [MEMORY.md](./MEMORY.md) for persistent knowledge (rules in its §22), this file for new rules, [ARCHITECTURE.md](./ARCHITECTURE.md) for structure/route changes, [PRD.md](./PRD.md) for capability status. Do not copy the same detail into all of them. Never document planned work as implemented.

---

## 26. Rules for AI Coding Agents

Follow [AGENTS.md](../AGENTS.md): read before acting, investigate the whole path, implement the smallest correct change, run the gates, report what was not done. When in doubt, do not guess — investigate.
