import {
    EntitlementState,
    InstanceState,
    ServiceScope,
    TenantState,
} from '../constants';

export interface TenantRecord {
    tenant_id: string;
    name: string;
    state: TenantState;
    entitlement_state: EntitlementState;
    created_at: string;
    updated_at: string;
}

export interface SecretVersionRecord {
    version_id: string;
    secret_hash: string;
    created_at: string;
    adopted_at?: string;
    revoked_at?: string;
    valid_until?: string;
}

export interface ClientCredentialsRecord {
    client_id: string;
    current_secret_version_id: string;
    next_secret_version_id?: string;
    secret_versions: SecretVersionRecord[];
}

export interface InstanceRecord {
    instance_id: string;
    tenant_id: string;
    source: string;
    state: InstanceState;
    allowed_services: ServiceScope[];
    client_credentials?: ClientCredentialsRecord;
    created_at: string;
    updated_at: string;
}

export interface CreateTenantInput {
    tenant_id: string;
    name: string;
    state?: TenantState;
    entitlement_state?: EntitlementState;
    actor?: string;
}

export interface CreateInstanceInput {
    instance_id: string;
    tenant_id: string;
    source: string;
    state?: InstanceState;
    allowed_services?: ServiceScope[];
    actor?: string;
}

export interface InitialCredentialsInput {
    instance_id: string;
    client_id: string;
    version_id: string;
    secret_hash: string;
}

export interface AddSecretVersionInput {
    instance_id: string;
    version_id: string;
    secret_hash: string;
    valid_until?: string;
}
