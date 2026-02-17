export const SERVICE_SCOPES = ['reg', 'rrs'] as const;

export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export const TENANT_STATES = ['active', 'suspended', 'disabled'] as const;

export type TenantState = (typeof TENANT_STATES)[number];

export const ENTITLEMENT_STATES = ['active', 'suspended', 'disabled'] as const;

export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];

export const INSTANCE_STATES = ['active', 'suspended', 'disabled'] as const;

export type InstanceState = (typeof INSTANCE_STATES)[number];

export const AUTH_DENY_REASON_CODES = [
    'none',
    'denied_auth_control_plane_outage',
    'denied_invalid_client',
    'denied_invalid_secret',
    'denied_invalid_grant',
    'denied_tenant_not_entitled',
    'denied_tenant_suspended',
    'denied_tenant_disabled',
    'denied_instance_suspended',
    'denied_instance_disabled',
    'denied_service_not_allowed',
    'denied_invalid_enrollment_code',
    'denied_enrollment_code_expired',
    'denied_enrollment_code_used',
    'denied_token_expired',
    'denied_token_invalid_signature',
    'denied_token_wrong_service_scope',
    'denied_token_malformed',
] as const;

export type AuthDenyReasonCode = (typeof AUTH_DENY_REASON_CODES)[number];

export const IN_FLIGHT_REASON_CODES = [
    'none',
    'paused_token_refresh_grace_exhausted',
    'paused_entitlement_disabled',
    'paused_instance_disabled',
    'blocked_auth_control_plane_outage',
] as const;

export type InFlightReasonCode = (typeof IN_FLIGHT_REASON_CODES)[number];

export function isServiceScope(value: string): value is ServiceScope {
    return SERVICE_SCOPES.includes(value as ServiceScope);
}
