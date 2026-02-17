# Auth Control Plane Runbooks (RS-02)

## 1. Compromised Secret

1. Identify impacted `instance_id` and `secret_version_id`.
2. Call `POST /v1/admin/instances/{instance_id}/revoke-secret` with reason
   `compromised`.
3. Immediately call `POST /v1/admin/instances/{instance_id}/rotate-secret` to
   mint a replacement secret version.
4. Confirm SN instance adopts the replacement credential.
5. Complete rotation via `POST /v1/admin/instances/{instance_id}/complete-rotation`.
6. Verify deny/mint audit trail in `GET /v1/admin/audit-events`.

## 2. Enrollment Failure

1. Confirm tenant and instance registry records exist and are active.
2. Issue a new one-time enrollment code via
   `POST /v1/admin/enrollment-codes`.
3. Ensure code TTL has not expired and code has not been reused.
4. Retry `POST /v1/auth/enroll/exchange`.
5. Inspect audit events for reason codes:
   - `denied_invalid_enrollment_code`
   - `denied_enrollment_code_expired`
   - `denied_enrollment_code_used`
6. If repeated failure continues, invalidate stale onboarding artifacts and
   re-run onboarding from tenant/instance setup.

## 3. Emergency Revoke

1. Toggle outage/degraded mode if active attack is ongoing:
   `POST /v1/admin/degraded-mode` with `outage_active=true`.
2. Revoke affected secret versions immediately.
3. Suspend or disable impacted instance via
   `POST /v1/admin/instances/{instance_id}/state` when needed.
4. Rotate to a new secret once containment is complete.
5. Re-enable instance and clear outage mode after validation.
6. Export and retain audit events for incident postmortem.

## 4. Control Plane Outage

1. Set degraded mode so mint path fails closed for new starts.
2. Existing in-flight jobs continue until token expiry.
3. During refresh attempts, honor grace policy:
   - within grace: retry and remain paused-ready
   - beyond grace: pause with `paused_token_refresh_grace_exhausted`
4. Restore control plane availability and clear outage mode.
5. Resume paused jobs after successful token refresh.
6. Review audit stream for outage window and recovery actions.
