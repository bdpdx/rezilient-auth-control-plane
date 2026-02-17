import {
    ENTITLEMENT_STATES,
    INSTANCE_STATES,
    SERVICE_SCOPES,
    TENANT_STATES,
} from '../constants';
import { AuditService } from '../audit/audit.service';
import { Clock } from '../utils/clock';
import {
    AddSecretVersionInput,
    CreateInstanceInput,
    CreateTenantInput,
    InitialCredentialsInput,
    InstanceRecord,
    SecretVersionRecord,
    TenantRecord,
} from './types';

function cloneSecretVersion(secret: SecretVersionRecord): SecretVersionRecord {
    return {
        ...secret,
    };
}

function cloneInstance(instance: InstanceRecord): InstanceRecord {
    return {
        ...instance,
        allowed_services: [...instance.allowed_services],
        client_credentials: instance.client_credentials
            ? {
                ...instance.client_credentials,
                secret_versions: instance.client_credentials.secret_versions
                    .map((secret) => cloneSecretVersion(secret)),
            }
            : undefined,
    };
}

function cloneTenant(tenant: TenantRecord): TenantRecord {
    return {
        ...tenant,
    };
}

export class RegistryService {
    private readonly tenants = new Map<string, TenantRecord>();

    private readonly instances = new Map<string, InstanceRecord>();

    private readonly clientIdToInstance = new Map<string, string>();

    constructor(
        private readonly audit: AuditService,
        private readonly clock: Clock,
    ) {}

    createTenant(input: CreateTenantInput): TenantRecord {
        if (this.tenants.has(input.tenant_id)) {
            throw new Error(`tenant already exists: ${input.tenant_id}`);
        }

        const state = input.state ?? 'active';
        const entitlementState = input.entitlement_state ?? 'active';

        if (!TENANT_STATES.includes(state)) {
            throw new Error(`invalid tenant state: ${state}`);
        }

        if (!ENTITLEMENT_STATES.includes(entitlementState)) {
            throw new Error(
                `invalid entitlement state: ${entitlementState}`,
            );
        }

        const nowIso = this.clock.now().toISOString();
        const tenant: TenantRecord = {
            tenant_id: input.tenant_id,
            name: input.name,
            state,
            entitlement_state: entitlementState,
            created_at: nowIso,
            updated_at: nowIso,
        };

        this.tenants.set(tenant.tenant_id, tenant);

        this.audit.record({
            event_type: 'tenant_created',
            actor: input.actor,
            tenant_id: tenant.tenant_id,
            metadata: {
                state: tenant.state,
                entitlement_state: tenant.entitlement_state,
            },
        });

        return cloneTenant(tenant);
    }

    setTenantState(
        tenantId: string,
        state: TenantRecord['state'],
        actor?: string,
    ): TenantRecord {
        const tenant = this.getTenantOrThrow(tenantId);

        if (!TENANT_STATES.includes(state)) {
            throw new Error(`invalid tenant state: ${state}`);
        }

        tenant.state = state;
        tenant.updated_at = this.clock.now().toISOString();

        this.audit.record({
            event_type: 'tenant_state_changed',
            actor,
            tenant_id: tenant.tenant_id,
            metadata: {
                state: tenant.state,
            },
        });

        return cloneTenant(tenant);
    }

    setTenantEntitlement(
        tenantId: string,
        entitlementState: TenantRecord['entitlement_state'],
        actor?: string,
    ): TenantRecord {
        const tenant = this.getTenantOrThrow(tenantId);

        if (!ENTITLEMENT_STATES.includes(entitlementState)) {
            throw new Error(
                `invalid entitlement state: ${entitlementState}`,
            );
        }

        tenant.entitlement_state = entitlementState;
        tenant.updated_at = this.clock.now().toISOString();

        this.audit.record({
            event_type: 'tenant_entitlement_changed',
            actor,
            tenant_id: tenant.tenant_id,
            metadata: {
                entitlement_state: tenant.entitlement_state,
            },
        });

        return cloneTenant(tenant);
    }

    createInstance(input: CreateInstanceInput): InstanceRecord {
        if (this.instances.has(input.instance_id)) {
            throw new Error(`instance already exists: ${input.instance_id}`);
        }

        const tenant = this.getTenantOrThrow(input.tenant_id);
        const normalizedServices = (input.allowed_services ??
            [...SERVICE_SCOPES]).map((scope) => scope);

        for (const service of normalizedServices) {
            if (!SERVICE_SCOPES.includes(service)) {
                throw new Error(`invalid service scope: ${service}`);
            }
        }

        for (const instance of this.instances.values()) {
            if (instance.source === input.source) {
                throw new Error(
                    `source mapping already exists: ${input.source}`,
                );
            }
        }

        const state = input.state ?? 'active';

        if (!INSTANCE_STATES.includes(state)) {
            throw new Error(`invalid instance state: ${state}`);
        }

        const nowIso = this.clock.now().toISOString();
        const instance: InstanceRecord = {
            instance_id: input.instance_id,
            tenant_id: tenant.tenant_id,
            source: input.source,
            state,
            allowed_services: Array.from(new Set(normalizedServices)).sort(),
            created_at: nowIso,
            updated_at: nowIso,
        };

        this.instances.set(instance.instance_id, instance);

        this.audit.record({
            event_type: 'instance_created',
            actor: input.actor,
            tenant_id: instance.tenant_id,
            instance_id: instance.instance_id,
            metadata: {
                source: instance.source,
                allowed_services: instance.allowed_services,
                state: instance.state,
            },
        });

        return cloneInstance(instance);
    }

    setInstanceState(
        instanceId: string,
        state: InstanceRecord['state'],
        actor?: string,
    ): InstanceRecord {
        const instance = this.getInstanceOrThrow(instanceId);

        if (!INSTANCE_STATES.includes(state)) {
            throw new Error(`invalid instance state: ${state}`);
        }

        instance.state = state;
        instance.updated_at = this.clock.now().toISOString();

        this.audit.record({
            event_type: 'instance_state_changed',
            actor,
            tenant_id: instance.tenant_id,
            instance_id: instance.instance_id,
            metadata: {
                state: instance.state,
            },
        });

        return cloneInstance(instance);
    }

    setInstanceAllowedServices(
        instanceId: string,
        allowedServices: InstanceRecord['allowed_services'],
        actor?: string,
    ): InstanceRecord {
        const instance = this.getInstanceOrThrow(instanceId);

        for (const service of allowedServices) {
            if (!SERVICE_SCOPES.includes(service)) {
                throw new Error(`invalid service scope: ${service}`);
            }
        }

        instance.allowed_services = Array.from(new Set(allowedServices)).sort();
        instance.updated_at = this.clock.now().toISOString();

        this.audit.record({
            event_type: 'instance_services_updated',
            actor,
            tenant_id: instance.tenant_id,
            instance_id: instance.instance_id,
            metadata: {
                allowed_services: instance.allowed_services,
            },
        });

        return cloneInstance(instance);
    }

    setInitialCredentials(input: InitialCredentialsInput): InstanceRecord {
        const instance = this.getInstanceOrThrow(input.instance_id);

        if (this.clientIdToInstance.has(input.client_id)) {
            throw new Error(`client_id already assigned: ${input.client_id}`);
        }

        const nowIso = this.clock.now().toISOString();
        const secretVersion: SecretVersionRecord = {
            version_id: input.version_id,
            secret_hash: input.secret_hash,
            created_at: nowIso,
        };

        if (
            instance.client_credentials &&
            instance.client_credentials.client_id !== input.client_id
        ) {
            throw new Error(
                `instance already has credentials with different client_id`,
            );
        }

        instance.client_credentials = {
            client_id: input.client_id,
            current_secret_version_id: input.version_id,
            secret_versions: [secretVersion],
        };

        this.clientIdToInstance.set(input.client_id, instance.instance_id);
        instance.updated_at = nowIso;

        return cloneInstance(instance);
    }

    addNextSecretVersion(input: AddSecretVersionInput): InstanceRecord {
        const instance = this.getInstanceOrThrow(input.instance_id);
        const credentials = this.getCredentialsOrThrow(instance);

        if (credentials.next_secret_version_id) {
            throw new Error('rotation already in progress');
        }

        const existing = credentials.secret_versions.find(
            (secret) => secret.version_id === input.version_id,
        );

        if (existing) {
            throw new Error(`secret version already exists: ${input.version_id}`);
        }

        const nowIso = this.clock.now().toISOString();
        const secretVersion: SecretVersionRecord = {
            version_id: input.version_id,
            secret_hash: input.secret_hash,
            created_at: nowIso,
            valid_until: input.valid_until,
        };

        credentials.secret_versions.push(secretVersion);
        credentials.next_secret_version_id = input.version_id;
        instance.updated_at = nowIso;

        return cloneInstance(instance);
    }

    markSecretAdopted(instanceId: string, versionId: string): InstanceRecord {
        const instance = this.getInstanceOrThrow(instanceId);
        const credentials = this.getCredentialsOrThrow(instance);
        const secret = credentials.secret_versions.find(
            (entry) => entry.version_id === versionId,
        );

        if (!secret) {
            throw new Error(`secret version not found: ${versionId}`);
        }

        if (!secret.adopted_at) {
            secret.adopted_at = this.clock.now().toISOString();
            instance.updated_at = secret.adopted_at;
        }

        return cloneInstance(instance);
    }

    promoteNextSecret(instanceId: string): {
        instance: InstanceRecord;
        old_secret_version_id: string;
        new_secret_version_id: string;
    } {
        const instance = this.getInstanceOrThrow(instanceId);
        const credentials = this.getCredentialsOrThrow(instance);
        const nextId = credentials.next_secret_version_id;

        if (!nextId) {
            throw new Error('no next secret version to promote');
        }

        const nextSecret = credentials.secret_versions.find(
            (secret) => secret.version_id === nextId,
        );

        if (!nextSecret) {
            throw new Error(`next secret version not found: ${nextId}`);
        }

        const nowIso = this.clock.now().toISOString();
        const oldVersionId = credentials.current_secret_version_id;
        const oldSecret = credentials.secret_versions.find(
            (secret) => secret.version_id === oldVersionId,
        );

        if (!oldSecret) {
            throw new Error(`current secret version not found: ${oldVersionId}`);
        }

        oldSecret.revoked_at = nowIso;
        nextSecret.valid_until = undefined;
        credentials.current_secret_version_id = nextId;
        credentials.next_secret_version_id = undefined;
        instance.updated_at = nowIso;

        return {
            instance: cloneInstance(instance),
            old_secret_version_id: oldVersionId,
            new_secret_version_id: nextId,
        };
    }

    revokeSecretVersion(instanceId: string, versionId: string): InstanceRecord {
        const instance = this.getInstanceOrThrow(instanceId);
        const credentials = this.getCredentialsOrThrow(instance);
        const secret = credentials.secret_versions.find(
            (entry) => entry.version_id === versionId,
        );

        if (!secret) {
            throw new Error(`secret version not found: ${versionId}`);
        }

        secret.revoked_at = this.clock.now().toISOString();

        if (credentials.next_secret_version_id === versionId) {
            credentials.next_secret_version_id = undefined;
        }

        instance.updated_at = this.clock.now().toISOString();

        return cloneInstance(instance);
    }

    getTenant(tenantId: string): TenantRecord | undefined {
        const tenant = this.tenants.get(tenantId);

        return tenant ? cloneTenant(tenant) : undefined;
    }

    listTenants(): TenantRecord[] {
        return Array.from(this.tenants.values())
            .map((tenant) => cloneTenant(tenant))
            .sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));
    }

    getInstance(instanceId: string): InstanceRecord | undefined {
        const instance = this.instances.get(instanceId);

        return instance ? cloneInstance(instance) : undefined;
    }

    listInstances(): InstanceRecord[] {
        return Array.from(this.instances.values())
            .map((instance) => cloneInstance(instance))
            .sort((left, right) =>
                left.instance_id.localeCompare(right.instance_id),
            );
    }

    getInstanceByClientId(clientId: string): InstanceRecord | undefined {
        const instanceId = this.clientIdToInstance.get(clientId);

        if (!instanceId) {
            return undefined;
        }

        const instance = this.instances.get(instanceId);

        return instance ? cloneInstance(instance) : undefined;
    }

    private getTenantOrThrow(tenantId: string): TenantRecord {
        const tenant = this.tenants.get(tenantId);

        if (!tenant) {
            throw new Error(`tenant not found: ${tenantId}`);
        }

        return tenant;
    }

    private getInstanceOrThrow(instanceId: string): InstanceRecord {
        const instance = this.instances.get(instanceId);

        if (!instance) {
            throw new Error(`instance not found: ${instanceId}`);
        }

        return instance;
    }

    private getCredentialsOrThrow(instance: InstanceRecord) {
        if (!instance.client_credentials) {
            throw new Error(
                `instance has no client credentials: ${instance.instance_id}`,
            );
        }

        return instance.client_credentials;
    }
}
