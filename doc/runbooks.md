# Auth Control Plane Runbooks (RS-02)

Updated: 2026-02-23

This file is the ACP runbook index.

## Core runbooks

1. Planned instance credential rotation:
   - `../../doc/ops/acp/auth_secret_rotation_planned_runbook.md`
2. Emergency secret revoke and containment:
   - `../../doc/ops/acp/auth_secret_emergency_revoke_runbook.md`
3. ACP persistence bootstrap and migration:
   - `../../doc/ops/acp/persistence_setup.md`
4. ACP secure bootstrap and fail-closed requirements:
   - `../../doc/ops/acp/secure_bootstrap.md`
5. ACP monitoring and alert hooks:
   - `../../doc/ops/acp/monitoring_checks.md`

## Quick endpoint map

- `POST /v1/admin/instances/{instance_id}/rotate-secret`
- `POST /v1/admin/instances/{instance_id}/complete-rotation`
- `POST /v1/admin/instances/{instance_id}/revoke-secret`
- `POST /v1/admin/instances/{instance_id}/state`
- `POST /v1/admin/degraded-mode`
- `GET /v1/admin/instances/{instance_id}`
- `GET /v1/admin/overview`
- `GET /v1/admin/audit-events?limit=<n>`

## Fast triage notes

- `complete-rotation` fails with `reason_code=secret_rotation_not_adopted`
  until mint succeeds with the next secret version.
- Revoke and state-change actions must be followed by audit evidence export
  from `/v1/admin/audit-events`.
- Use degraded mode only for incident-wide containment, not routine rotation.
