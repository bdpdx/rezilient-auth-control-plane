import {
    ENTITLEMENT_STATES,
    INSTANCE_STATES,
    SERVICE_SCOPES,
    TENANT_STATES,
} from '../constants';
import { AuditService } from '../audit/audit.service';
import { InMemoryControlPlaneStateStore } from '../persistence/in-memory-state-store';
import { ControlPlaneStateStore } from '../persistence/state-store';
import { ControlPlaneState } from '../persistence/types';
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
    constructor(
        private readonly audit: AuditService,
        private readonly clock: Clock,
        private readonly stateStore: ControlPlaneStateStore =
            new InMemoryControlPlaneStateStore(),
    ) {}

    async createTenant(input: CreateTenantInput): Promise<TenantRecord> {
        const tenant = await this.stateStore.mutate((state) => {
            if (state.tenants[input.tenant_id]) {
                throw new Error(`tenant already exists: ${input.tenant_id}`);
            }

            const stateValue = input.state ?? 'active';
            const entitlementState = input.entitlement_state ?? 'active';

            if (!TENANT_STATES.includes(stateValue)) {
                throw new Error(`invalid tenant state: ${stateValue}`);
            }

            if (!ENTITLEMENT_STATES.includes(entitlementState)) {
                throw new Error(
                    `invalid entitlement state: ${entitlementState}`,
                );
            }

            const nowIso = this.clock.now().toISOString();
            const created: TenantRecord = {
                tenant_id: input.tenant_id,
                name: input.name,
                state: stateValue,
                entitlement_state: entitlementState,
                created_at: nowIso,
                updated_at: nowIso,
            };

            state.tenants[created.tenant_id] = created;

            return cloneTenant(created);
        });

        await this.audit.record({
            event_type: 'tenant_created',
            actor: input.actor,
            tenant_id: tenant.tenant_id,
            metadata: {
                state: tenant.state,
                entitlement_state: tenant.entitlement_state,
            },
        });

        return tenant;
    }

    async setTenantState(
        tenantId: string,
        stateValue: TenantRecord['state'],
        actor?: string,
    ): Promise<TenantRecord> {
        const tenant = await this.stateStore.mutate((state) => {
            const tenantRecord = this.getTenantOrThrow(state, tenantId);

            if (!TENANT_STATES.includes(stateValue)) {
                throw new Error(`invalid tenant state: ${stateValue}`);
            }

            tenantRecord.state = stateValue;
            tenantRecord.updated_at = this.clock.now().toISOString();

            return cloneTenant(tenantRecord);
        });

        await this.audit.record({
            event_type: 'tenant_state_changed',
            actor,
            tenant_id: tenant.tenant_id,
            metadata: {
                state: tenant.state,
            },
        });

        return tenant;
    }

    async setTenantEntitlement(
        tenantId: string,
        entitlementState: TenantRecord['entitlement_state'],
        actor?: string,
    ): Promise<TenantRecord> {
        const tenant = await this.stateStore.mutate((state) => {
            const tenantRecord = this.getTenantOrThrow(state, tenantId);

            if (!ENTITLEMENT_STATES.includes(entitlementState)) {
                throw new Error(
                    `invalid entitlement state: ${entitlementState}`,
                );
            }

            tenantRecord.entitlement_state = entitlementState;
            tenantRecord.updated_at = this.clock.now().toISOString();

            return cloneTenant(tenantRecord);
        });

        await this.audit.record({
            event_type: 'tenant_entitlement_changed',
            actor,
            tenant_id: tenant.tenant_id,
            metadata: {
                entitlement_state: tenant.entitlement_state,
            },
        });

        return tenant;
    }

    async createInstance(input: CreateInstanceInput): Promise<InstanceRecord> {
        const instance = await this.stateStore.mutate((state) => {
            if (state.instances[input.instance_id]) {
                throw new Error(`instance already exists: ${input.instance_id}`);
            }

            const tenant = this.getTenantOrThrow(state, input.tenant_id);
            const normalizedServices = (input.allowed_services ??
                [...SERVICE_SCOPES]).map((scope) => scope);

            for (const service of normalizedServices) {
                if (!SERVICE_SCOPES.includes(service)) {
                    throw new Error(`invalid service scope: ${service}`);
                }
            }

            for (const existing of Object.values(state.instances)) {
                if (existing.source === input.source) {
                    throw new Error(
                        `source mapping already exists: ${input.source}`,
                    );
                }
            }

            const stateValue = input.state ?? 'active';

            if (!INSTANCE_STATES.includes(stateValue)) {
                throw new Error(`invalid instance state: ${stateValue}`);
            }

            const nowIso = this.clock.now().toISOString();
            const created: InstanceRecord = {
                instance_id: input.instance_id,
                tenant_id: tenant.tenant_id,
                source: input.source,
                state: stateValue,
                allowed_services: Array.from(
                    new Set(normalizedServices),
                ).sort(),
                created_at: nowIso,
                updated_at: nowIso,
            };

            state.instances[created.instance_id] = created;

            return cloneInstance(created);
        });

        await this.audit.record({
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

        return instance;
    }

    async setInstanceState(
        instanceId: string,
        stateValue: InstanceRecord['state'],
        actor?: string,
    ): Promise<InstanceRecord> {
        const instance = await this.stateStore.mutate((state) => {
            const record = this.getInstanceOrThrow(state, instanceId);

            if (!INSTANCE_STATES.includes(stateValue)) {
                throw new Error(`invalid instance state: ${stateValue}`);
            }

            record.state = stateValue;
            record.updated_at = this.clock.now().toISOString();

            return cloneInstance(record);
        });

        await this.audit.record({
            event_type: 'instance_state_changed',
            actor,
            tenant_id: instance.tenant_id,
            instance_id: instance.instance_id,
            metadata: {
                state: instance.state,
            },
        });

        return instance;
    }

    async setInstanceAllowedServices(
        instanceId: string,
        allowedServices: InstanceRecord['allowed_services'],
        actor?: string,
    ): Promise<InstanceRecord> {
        const instance = await this.stateStore.mutate((state) => {
            const record = this.getInstanceOrThrow(state, instanceId);

            for (const service of allowedServices) {
                if (!SERVICE_SCOPES.includes(service)) {
                    throw new Error(`invalid service scope: ${service}`);
                }
            }

            record.allowed_services = Array.from(
                new Set(allowedServices),
            ).sort();
            record.updated_at = this.clock.now().toISOString();

            return cloneInstance(record);
        });

        await this.audit.record({
            event_type: 'instance_services_updated',
            actor,
            tenant_id: instance.tenant_id,
            instance_id: instance.instance_id,
            metadata: {
                allowed_services: instance.allowed_services,
            },
        });

        return instance;
    }

    async setInitialCredentials(
        input: InitialCredentialsInput,
    ): Promise<InstanceRecord> {
        return await this.stateStore.mutate((state) => {
            const instance = this.getInstanceOrThrow(state, input.instance_id);

            if (state.client_id_to_instance[input.client_id]) {
                throw new Error(`client_id already assigned: ${input.client_id}`);
            }

            if (
                instance.client_credentials &&
                instance.client_credentials.client_id !== input.client_id
            ) {
                throw new Error(
                    'instance already has credentials with different client_id',
                );
            }

            const nowIso = this.clock.now().toISOString();
            const secretVersion: SecretVersionRecord = {
                version_id: input.version_id,
                secret_hash: input.secret_hash,
                created_at: nowIso,
            };

            instance.client_credentials = {
                client_id: input.client_id,
                current_secret_version_id: input.version_id,
                secret_versions: [secretVersion],
            };

            state.client_id_to_instance[input.client_id] = instance.instance_id;
            instance.updated_at = nowIso;

            return cloneInstance(instance);
        });
    }

    async addNextSecretVersion(
        input: AddSecretVersionInput,
    ): Promise<InstanceRecord> {
        return await this.stateStore.mutate((state) => {
            const instance = this.getInstanceOrThrow(state, input.instance_id);
            const credentials = this.getCredentialsOrThrow(instance);

            if (credentials.next_secret_version_id) {
                throw new Error('rotation already in progress');
            }

            const existing = credentials.secret_versions.find(
                (secret) => secret.version_id === input.version_id,
            );

            if (existing) {
                throw new Error(
                    `secret version already exists: ${input.version_id}`,
                );
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
        });
    }

    async markSecretAdopted(
        instanceId: string,
        versionId: string,
    ): Promise<InstanceRecord> {
        return await this.stateStore.mutate((state) => {
            const instance = this.getInstanceOrThrow(state, instanceId);
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
        });
    }

    async promoteNextSecret(instanceId: string): Promise<{
        instance: InstanceRecord;
        old_secret_version_id: string;
        new_secret_version_id: string;
    }> {
        return await this.stateStore.mutate((state) => {
            const instance = this.getInstanceOrThrow(state, instanceId);
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

            if (!nextSecret.adopted_at) {
                throw new Error(
                    `next secret version not adopted: ${nextId}`,
                );
            }

            const nowIso = this.clock.now().toISOString();
            const oldVersionId = credentials.current_secret_version_id;
            const oldSecret = credentials.secret_versions.find(
                (secret) => secret.version_id === oldVersionId,
            );

            if (!oldSecret) {
                throw new Error(
                    `current secret version not found: ${oldVersionId}`,
                );
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
        });
    }

    async revokeSecretVersion(
        instanceId: string,
        versionId: string,
    ): Promise<InstanceRecord> {
        return await this.stateStore.mutate((state) => {
            const instance = this.getInstanceOrThrow(state, instanceId);
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
        });
    }

    async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
        const tenant = (await this.stateStore.read()).tenants[tenantId];

        return tenant ? cloneTenant(tenant) : undefined;
    }

    async listTenants(): Promise<TenantRecord[]> {
        return Object.values((await this.stateStore.read()).tenants)
            .map((tenant) => cloneTenant(tenant))
            .sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));
    }

    async getInstance(instanceId: string): Promise<InstanceRecord | undefined> {
        const instance = (await this.stateStore.read()).instances[instanceId];

        return instance ? cloneInstance(instance) : undefined;
    }

    async listInstances(): Promise<InstanceRecord[]> {
        return Object.values((await this.stateStore.read()).instances)
            .map((instance) => cloneInstance(instance))
            .sort((left, right) =>
                left.instance_id.localeCompare(right.instance_id),
            );
    }

    async getInstanceByClientId(
        clientId: string,
    ): Promise<InstanceRecord | undefined> {
        const state = await this.stateStore.read();
        const instanceId = state.client_id_to_instance[clientId];

        if (!instanceId) {
            return undefined;
        }

        const instance = state.instances[instanceId];

        return instance ? cloneInstance(instance) : undefined;
    }

    private getTenantOrThrow(
        state: ControlPlaneState,
        tenantId: string,
    ): TenantRecord {
        const tenant = state.tenants[tenantId];

        if (!tenant) {
            throw new Error(`tenant not found: ${tenantId}`);
        }

        return tenant;
    }

    private getInstanceOrThrow(
        state: ControlPlaneState,
        instanceId: string,
    ): InstanceRecord {
        const instance = state.instances[instanceId];

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
