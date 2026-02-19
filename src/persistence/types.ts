import { AuthAuditEvent } from '../audit/types';
import { CrossServiceAuditEvent } from '@rezilient/types';
import {
    InstanceRecord,
    TenantRecord,
} from '../registry/types';

export interface EnrollmentCodeRecord {
    code_id: string;
    code_hash: string;
    tenant_id: string;
    instance_id: string;
    issued_at: string;
    expires_at: string;
    used_at?: string;
    issued_by?: string;
}

export interface ControlPlaneState {
    tenants: Record<string, TenantRecord>;
    instances: Record<string, InstanceRecord>;
    client_id_to_instance: Record<string, string>;
    enrollment_records: Record<string, EnrollmentCodeRecord>;
    code_hash_to_id: Record<string, string>;
    audit_events: AuthAuditEvent[];
    cross_service_audit_events: CrossServiceAuditEvent[];
    outage_active: boolean;
}

export function createEmptyControlPlaneState(): ControlPlaneState {
    return {
        tenants: {},
        instances: {},
        client_id_to_instance: {},
        enrollment_records: {},
        code_hash_to_id: {},
        audit_events: [],
        cross_service_audit_events: [],
        outage_active: false,
    };
}

export function cloneControlPlaneState(
    state: ControlPlaneState,
): ControlPlaneState {
    return JSON.parse(
        JSON.stringify(state),
    ) as ControlPlaneState;
}
