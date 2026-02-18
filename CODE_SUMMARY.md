# rezilient-auth-control-plane Code Summary

Purpose:
- Shared authentication control plane for `REG` and `RRS`.
- Manages tenant/instance registry, enrollment bootstrap, rotating client
  secrets, service-scoped token minting/validation, and auth audit events.

Primary entrypoints:
- `src/index.ts`: process bootstrap, runtime config validation, and durable
  SQLite-backed state store wiring.
- `src/server.ts`: minimal HTTP API for admin + token endpoints.
- `src/server.ts`: HTTP API for admin/token endpoints, including RS-14 admin
  overview + tenant/instance read surfaces and optional admin-token guard.
- `src/registry/registry.service.ts`: tenant/instance registry and lifecycle.
- `src/enrollment/enrollment.service.ts`: one-time enrollment code issue/exchange.
- `src/token/token.service.ts`: client credential mint + token validation.
- `src/rotation/rotation.service.ts`: dual-secret overlap rotation lifecycle.
- `src/audit/audit.service.ts`: append-only auth audit stream.
- `src/persistence/*`: shared state-store abstractions and SQLite/in-memory
  implementations for durable ACP state.

Testing:
- `src/token/token.service.test.ts`
- `src/enrollment/enrollment.integration.test.ts`
- `src/rotation/rotation.integration.test.ts`
- `src/failure-modes.test.ts`
- `src/server.admin.integration.test.ts`
