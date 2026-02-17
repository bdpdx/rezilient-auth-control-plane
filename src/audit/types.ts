import {
    AuthDenyReasonCode,
    InFlightReasonCode,
    ServiceScope,
} from '../constants';

export const AUTH_AUDIT_EVENT_TYPES = [
    'tenant_created',
    'tenant_state_changed',
    'tenant_entitlement_changed',
    'instance_created',
    'instance_state_changed',
    'instance_services_updated',
    'enrollment_code_issued',
    'enrollment_code_exchanged',
    'token_minted',
    'token_refreshed',
    'token_mint_denied',
    'token_validated',
    'token_validate_denied',
    'secret_rotation_started',
    'secret_rotation_adopted',
    'secret_rotation_completed',
    'secret_revoked',
    'control_plane_outage_mode_changed',
] as const;

export type AuthAuditEventType = (typeof AUTH_AUDIT_EVENT_TYPES)[number];

export interface AuthAuditEvent {
    event_id: string;
    event_type: AuthAuditEventType;
    occurred_at: string;
    actor?: string;
    tenant_id?: string;
    instance_id?: string;
    client_id?: string;
    service_scope?: ServiceScope;
    deny_reason_code?: AuthDenyReasonCode;
    in_flight_reason_code?: InFlightReasonCode;
    metadata: Record<string, unknown>;
}
