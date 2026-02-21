# src Index

- `index.ts`: bootstraps control plane, validates runtime config, and defaults
  to durable Postgres-backed state.
- `server.ts`: HTTP routing for admin, enrollment, token, and health endpoints.
- `server.ts`: HTTP routing for admin, enrollment, token, and health endpoints,
  plus RS-14 admin overview, instance/tenant read APIs, and
  `/v1/admin/audit-events/cross-service`.
- `constants.ts`: enums and reason codes for registry/token decisions.
- `utils/clock.ts`: clock abstraction used by deterministic tests.
- `utils/crypto.ts`: token signing/verification and secret hashing helpers.
- `audit/audit.service.ts`: append-only auth audit recorder plus normalized
  cross-service event emission/listing.
- `audit/types.ts`: audit event types and payload shape.
- `audit/audit.service.test.ts`: normalized cross-service audit emission and
  replay-order list coverage.
- `persistence/state-store.ts`: shared persistence interface for ACP state.
- `persistence/postgres-state-store.ts`: Postgres-backed durable state store.
- `persistence/migrate.ts`: versioned Postgres migration runner for ACP state
  bootstrap.
- `persistence/in-memory-state-store.ts`: in-memory store used by tests.
- `registry/types.ts`: tenant/instance/credential domain models.
- `registry/registry.service.ts`: registry lifecycle operations.
- `enrollment/enrollment.service.ts`: enrollment code issue/exchange flow.
- `rotation/rotation.service.ts`: secret rotation/revoke lifecycle.
- `token/token.service.ts`: client-credential mint/validation/failure policies.
- `token/token.service.test.ts`: mint/deny matrix unit tests.
- `enrollment/enrollment.integration.test.ts`: enrollment integration tests.
- `rotation/rotation.integration.test.ts`: rotation integration tests.
- `failure-modes.test.ts`: outage grace + entitlement-disable tests.
- `server.admin.integration.test.ts`: admin-token guard and RS-14 admin API
  integration coverage.
