# src Index

- `index.ts`: bootstraps in-memory control plane and starts HTTP server.
- `server.ts`: HTTP routing for admin, enrollment, token, and health endpoints.
- `server.ts`: HTTP routing for admin, enrollment, token, and health endpoints,
  plus RS-14 admin overview and instance/tenant read APIs.
- `constants.ts`: enums and reason codes for registry/token decisions.
- `utils/clock.ts`: clock abstraction used by deterministic tests.
- `utils/crypto.ts`: token signing/verification and secret hashing helpers.
- `audit/audit.service.ts`: append-only audit event recorder.
- `audit/types.ts`: audit event types and payload shape.
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
