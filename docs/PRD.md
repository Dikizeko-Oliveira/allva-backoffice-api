# Allva Backoffice API — Product Requirements Document

> **Scope:** the internal-process capabilities this service gives Allva staff (operators), through `allva-backoffice-web`.
> **Not in scope:** how it is built ([ARCHITECTURE.md](./ARCHITECTURE.md)); the customer product and product data (`allva-api/docs/PRD.md`); screens and navigation (`allva-backoffice-web/docs/PRD.md`).
> **Last audited against the code:** 2026-10-16, branch `main`, commit `5f13e9b`. The running code wins over this document.

See also: [Agent Instructions](../AGENTS.md) · [Architecture](./ARCHITECTURE.md) · [Engineering Rules](./RULES.md) · [Project Memory](./MEMORY.md) · [Specification](./backoffice-api.md)

Status markers: `[IMPLEMENTED]` `[PARTIAL]` `[PLANNED]` `[DECISION]` `[CONSTRAINT]` `[VERIFY]`

---

## 1. Product Overview

Allva is an **Evidence-based Ads Intelligence** platform. Its staff operate the customer base through an internal panel. `allva-backoffice-api` is the backend for **how the Allva team works** — attendance SLA, internal notes, operator preferences, internal alerts, contract negotiation before signature and the audit of those actions. It does not serve customers and does not own product data.

---

## 2. Problem

Without this service, internal process would have to live in `allva-api`, coupling the customer product to the team's way of working: changing an escalation rule would require a migration in the customer database, and operator-only notes would sit next to customer records. Operators also need to know, on their first screen, what in their area needs attention now.

---

## 3. Product Vision

One place for internal process, with the same permission vocabulary as the product, so that every operator sees exactly what their capabilities allow and every internal action is traceable.

---

## 4. Target Users

Allva operators — accounts with a platform role in `allva-api`. Customers (role `USER`, no platform role) are refused on every route.

| Role (in `allva-api`) | Typical use of this service |
|---|---|
| `ALLVA_ADMIN` | Everything, including SLA policies, alert rules and note moderation (`settings:manage`) |
| `ALLVA_OPERATOR` | Audit trail (`audit:read`); alerts of operations rules |
| `ALLVA_SUPPORT` | Support queue, SLA, assignment, metrics; notes on organizations/accounts |
| `ALLVA_FINANCE` | Contract drafts and conversion; notes on contracts |
| `ALLVA_SALES` | Notes on leads |

`[CONSTRAINT]` The table is illustrative. This service decides by **permission**, never by role; the matrix lives in `allva-api`.

---

## 5. Core Value Proposition

- A support queue that knows deadlines and risk, which the product does not.
- Internal knowledge (notes, saved views) that never reaches the customer.
- Hub signals filtered to the operator's own area.
- An audit trail of internal actions that sits alongside the product's.

---

## 6. Product Principles

1. **Internal process only.** Product data stays in `allva-api` and is referenced by id.
2. **One permission vocabulary** for the three backoffice pieces.
3. **Fail closed.** If identity cannot be confirmed, nothing is served.
4. **Act as the operator.** Product changes are made with the operator's own credentials.
5. **What you cannot see does not exist** for you (`404`, absent signals).
6. **Every internal write is audited.**

---

## 7. Capabilities

| Id | Capability | Status |
|---|---|---|
| Hub | Internal "Requires attention" signals | `[PARTIAL]` |
| C1 | Support process: SLA policies, deadlines, queue, assignment history, escalation | `[PARTIAL]` |
| C5 | Support metrics | `[PARTIAL]` |
| C2 | Internal notes on organizations, accounts, leads, contracts | `[IMPLEMENTED]` |
| C3 | Operator preferences and saved views | `[IMPLEMENTED]` |
| C4 | Internal operational alerts | `[PARTIAL]` |
| C6 | Pre-signature contract drafts and conversion | `[PARTIAL]` |
| Audit | Internal audit trail | `[IMPLEMENTED]` |

---

## 8. Functional Requirements

### 8.1 Hub

- `[IMPLEMENTED]` Any operator gets the internal signals of their area, in the same format as the product's hub: SLA breached, SLA at risk (2 h), escalated, assigned to me and waiting, unacknowledged alerts.
- `[IMPLEMENTED]` A signal outside the operator's permissions is absent, not zero; a failed count is "unavailable" (`null`), not zero.
- `[PARTIAL]` Counts cover only tickets this service has already seen (no polling); `escalated` is always 0; alerts have no producer.

### 8.2 C1 — Support process

- `[IMPLEMENTED]` Queue of product tickets enriched with first-response and resolution deadlines, SLA state (`ON_TRACK`, `AT_RISK`, `BREACHED`) and escalation fields, sorted by risk; filters forwarded to the product plus a `sla` filter.
- `[IMPLEMENTED]` Ticket detail with SLA.
- `[IMPLEMENTED]` Assign / reassign / unassign through the product; reassignment requires a reason; each change is kept in an internal history.
- `[IMPLEMENTED]` SLA policies per priority and optional category, one active per scope; conservative defaults when none applies; deadlines fixed at the ticket's first sighting.
- `[PLANNED]` Business-hours calendar (the flag is stored but ignored).
- `[PLANNED]` Escalation (every 5 min) and ticket polling (every 1–2 min).

### 8.3 C5 — Support metrics

- `[IMPLEMENTED]` Assignments per period/operator and % within SLA.
- `[PLANNED]` Median/p90 first response and resolution; resolved and reopened volume.
- `[VERIFY]` The spec requires `support:manage` to filter by another operator; the code requires `support:read`.

### 8.4 C2 — Internal notes

- `[IMPLEMENTED]` Create, list, edit, pin and soft-delete notes on an organization, account, lead or contract.
- `[IMPLEMENTED]` Reading/writing requires the permission that sees the subject; a note can be restricted to a further permission; only the author or a moderator (`settings:manage`) changes it.

### 8.5 C3 — Preferences and saved views

- `[IMPLEMENTED]` Per-operator last workspace, sidebar state, density and timezone.
- `[IMPLEMENTED]` Saved views per screen (filters, columns, sort, default, shared); shared views appear only to operators who can open that screen; only the owner changes a view.

### 8.6 C4 — Internal alerts

- `[IMPLEMENTED]` Alert rules (source, threshold, channel `EMAIL`/`SLACK`, target, required permission, quiet hours, active) managed under `settings:manage`.
- `[IMPLEMENTED]` Listing and acknowledging events, scoped by the rule's permission; first acknowledgement wins.
- `[PLANNED]` Evaluating rules, creating events, deduplication, sending notifications — none exists; requires a service credential.

### 8.7 C6 — Contract drafts

- `[IMPLEMENTED]` Drafts linked to a sales lead with terms, status and signature/envelope fields; read `billing:read`, write `billing:manage`.
- `[IMPLEMENTED]` Conversion creates the real contract in `allva-api` once, stores its id and locks the draft.
- `[PLANNED]` Signature-provider webhook; forwarding the signed PDF to the product.

### 8.8 Audit

- `[IMPLEMENTED]` Every internal write is recorded (actor, action, subject, before/after, reason) and listable under `audit:read`, compatible with the product trail.
- `[PARTIAL]` IP and user agent recorded only for ticket assignment.

---

## 9. Non-Functional Requirements

- **Own database**, no connection to the product database. `[IMPLEMENTED]`
- **Identity freshness:** permission changes and revocations take effect within 60 s. `[IMPLEMENTED]`
- **Failure isolation:** every product call has a timeout; no synchronous retry chains; the hub degrades per signal. `[IMPLEMENTED]`
- **Formats** identical to the product (pagination, errors). `[IMPLEMENTED]`
- **Rate limit** per operator on writes. `[PLANNED]`
- **Service credential** for jobs. `[PLANNED]`

---

## 10. Out of Scope

Product data of any kind; customer subscriptions, entitlements, billing and payments; Ads integrations; AI; token issuing and passwords; the permission matrix; screens and navigation.

---

## 11. Current Product State

The HTTP surface for all buckets exists. `allva-backoffice-web` consumes the hub, the support queue, ticket detail, assignment and the audit trail; notes, views, alerts, drafts, SLA policies and metrics have no screen yet `[VERIFY]`. No background processing exists. Deploy is manual.

---

## 12. Known Limitations

See [MEMORY.md §16–17](./MEMORY.md#16-known-technical-debt).

---

## 13. Planned Capabilities

See [MEMORY.md §18](./MEMORY.md#18-planned--not-yet-implemented). Open product decisions are in [`backoffice-api.md`](./backoffice-api.md) §8.
