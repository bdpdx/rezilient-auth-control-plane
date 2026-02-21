CREATE TABLE IF NOT EXISTS acp_state_snapshots (
    snapshot_key TEXT PRIMARY KEY,
    version BIGINT NOT NULL,
    state_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO acp_state_snapshots (
    snapshot_key,
    version,
    state_json,
    updated_at
) VALUES (
    'default',
    0,
    '{
      "tenants": {},
      "instances": {},
      "client_id_to_instance": {},
      "enrollment_records": {},
      "code_hash_to_id": {},
      "audit_events": [],
      "cross_service_audit_events": [],
      "outage_active": false
    }'::jsonb,
    NOW()
)
ON CONFLICT (snapshot_key) DO NOTHING;
