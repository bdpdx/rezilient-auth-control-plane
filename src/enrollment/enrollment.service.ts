import { AuditService } from '../audit/audit.service';
import { AuthDenyReasonCode } from '../constants';
import { InMemoryControlPlaneStateStore } from '../persistence/in-memory-state-store';
import { ControlPlaneStateStore } from '../persistence/state-store';
import { ControlPlaneState } from '../persistence/types';
import { RegistryService } from '../registry/registry.service';
import { SecretVersionRecord } from '../registry/types';
import { Clock } from '../utils/clock';
import {
    randomToken,
    sha256Hex,
} from '../utils/crypto';

interface EnrollmentCodeRecord {
    code_id: string;
    code_hash: string;
    tenant_id: string;
    instance_id: string;
    issued_at: string;
    expires_at: string;
    used_at?: string;
    issued_by?: string;
}

export interface IssueEnrollmentCodeInput {
    tenant_id: string;
    instance_id: string;
    requested_by?: string;
    ttl_seconds: number;
}

export interface IssueEnrollmentCodeResult {
    code_id: string;
    enrollment_code: string;
    expires_at: string;
}

export type ExchangeEnrollmentCodeResult = {
    success: true;
    tenant_id: string;
    instance_id: string;
    client_id: string;
    client_secret: string;
    secret_version_id: string;
} | {
    success: false;
    reason_code: AuthDenyReasonCode;
};

interface ExchangeSuccessPayload {
    success: true;
    tenant_id: string;
    instance_id: string;
    client_id: string;
    client_secret: string;
    secret_version_id: string;
    code_id: string;
}

interface ExchangeFailurePayload {
    success: false;
    reason_code: AuthDenyReasonCode;
    code_id?: string;
    tenant_id?: string;
    instance_id?: string;
}

type ExchangeStateResult = ExchangeSuccessPayload | ExchangeFailurePayload;

function parseSecretVersionNumber(versionId: string): number {
    const prefix = 'sv_';

    if (!versionId.startsWith(prefix)) {
        return 0;
    }

    const value = Number(versionId.slice(prefix.length));

    if (Number.isNaN(value)) {
        return 0;
    }

    return value;
}

function nextSecretVersionId(existingVersions: SecretVersionRecord[]): string {
    const highestVersion = existingVersions.reduce(
        (max, secret) => Math.max(max, parseSecretVersionNumber(secret.version_id)),
        0,
    );

    return `sv_${highestVersion + 1}`;
}

function generateUniqueClientId(state: ControlPlaneState): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const clientId = `cli_${randomToken(12)}`;

        if (!state.client_id_to_instance[clientId]) {
            return clientId;
        }
    }

    throw new Error('unable to allocate unique client_id');
}

export class EnrollmentService {
    constructor(
        private readonly registry: RegistryService,
        private readonly audit: AuditService,
        private readonly clock: Clock,
        private readonly stateStore: ControlPlaneStateStore =
            new InMemoryControlPlaneStateStore(),
    ) {}

    async issueEnrollmentCode(
        input: IssueEnrollmentCodeInput,
    ): Promise<IssueEnrollmentCodeResult> {
        const tenant = await this.registry.getTenant(input.tenant_id);
        const instance = await this.registry.getInstance(input.instance_id);

        if (!tenant || !instance || instance.tenant_id !== tenant.tenant_id) {
            throw new Error('tenant/instance mapping not found');
        }

        const codeId = `enr_${randomToken(12)}`;
        const enrollmentCode = `enroll_${randomToken(24)}`;
        const codeHash = sha256Hex(enrollmentCode);
        const now = this.clock.now();
        const expiresAt = new Date(
            now.getTime() + (input.ttl_seconds * 1000),
        ).toISOString();

        const record: EnrollmentCodeRecord = {
            code_id: codeId,
            code_hash: codeHash,
            tenant_id: tenant.tenant_id,
            instance_id: instance.instance_id,
            issued_at: now.toISOString(),
            expires_at: expiresAt,
            issued_by: input.requested_by,
        };

        await this.stateStore.mutate((state) => {
            state.enrollment_records[codeId] = record;
            state.code_hash_to_id[codeHash] = codeId;
        });

        await this.audit.record({
            event_type: 'enrollment_code_issued',
            actor: input.requested_by,
            tenant_id: tenant.tenant_id,
            instance_id: instance.instance_id,
            metadata: {
                code_id: codeId,
                ttl_seconds: input.ttl_seconds,
                expires_at: expiresAt,
            },
        });

        return {
            code_id: codeId,
            enrollment_code: enrollmentCode,
            expires_at: expiresAt,
        };
    }

    async exchangeEnrollmentCode(
        enrollmentCode: string,
    ): Promise<ExchangeEnrollmentCodeResult> {
        const codeHash = sha256Hex(enrollmentCode);
        const nowIso = this.clock.now().toISOString();
        const stateResult = await this.stateStore.mutate((state) => {
            const codeId = state.code_hash_to_id[codeHash];

            if (!codeId) {
                return {
                    success: false,
                    reason_code: 'denied_invalid_enrollment_code',
                } as ExchangeFailurePayload;
            }

            const record = state.enrollment_records[codeId];

            if (!record) {
                return {
                    success: false,
                    reason_code: 'denied_invalid_enrollment_code',
                } as ExchangeFailurePayload;
            }

            if (record.used_at) {
                return {
                    success: false,
                    reason_code: 'denied_enrollment_code_used',
                    code_id: record.code_id,
                    tenant_id: record.tenant_id,
                    instance_id: record.instance_id,
                } as ExchangeFailurePayload;
            }

            if (nowIso > record.expires_at) {
                return {
                    success: false,
                    reason_code: 'denied_enrollment_code_expired',
                    code_id: record.code_id,
                    tenant_id: record.tenant_id,
                    instance_id: record.instance_id,
                } as ExchangeFailurePayload;
            }

            const instance = state.instances[record.instance_id];

            if (!instance) {
                return {
                    success: false,
                    reason_code: 'denied_invalid_enrollment_code',
                    code_id: record.code_id,
                    tenant_id: record.tenant_id,
                    instance_id: record.instance_id,
                } as ExchangeFailurePayload;
            }

            if (instance.client_credentials) {
                return {
                    success: false,
                    reason_code: 'denied_enrollment_code_used',
                    code_id: record.code_id,
                    tenant_id: record.tenant_id,
                    instance_id: record.instance_id,
                } as ExchangeFailurePayload;
            }

            const clientId = generateUniqueClientId(state);
            const clientSecret = `sec_${randomToken(32)}`;
            const secretVersionId = nextSecretVersionId([]);
            const secretVersion: SecretVersionRecord = {
                version_id: secretVersionId,
                secret_hash: sha256Hex(clientSecret),
                created_at: nowIso,
            };

            instance.client_credentials = {
                client_id: clientId,
                current_secret_version_id: secretVersionId,
                secret_versions: [secretVersion],
            };
            instance.updated_at = nowIso;
            state.client_id_to_instance[clientId] = instance.instance_id;
            record.used_at = nowIso;

            return {
                success: true,
                tenant_id: record.tenant_id,
                instance_id: record.instance_id,
                client_id: clientId,
                client_secret: clientSecret,
                secret_version_id: secretVersionId,
                code_id: record.code_id,
            } as ExchangeSuccessPayload;
        });

        if (!stateResult.success) {
            await this.audit.record({
                event_type: 'token_mint_denied',
                tenant_id: stateResult.tenant_id,
                instance_id: stateResult.instance_id,
                deny_reason_code: stateResult.reason_code,
                metadata: {
                    phase: 'enrollment_exchange',
                    code_id: stateResult.code_id,
                },
            });

            return {
                success: false,
                reason_code: stateResult.reason_code,
            };
        }

        await this.audit.record({
            event_type: 'enrollment_code_exchanged',
            tenant_id: stateResult.tenant_id,
            instance_id: stateResult.instance_id,
            client_id: stateResult.client_id,
            metadata: {
                code_id: stateResult.code_id,
                secret_version_id: stateResult.secret_version_id,
            },
        });

        return {
            success: true,
            tenant_id: stateResult.tenant_id,
            instance_id: stateResult.instance_id,
            client_id: stateResult.client_id,
            client_secret: stateResult.client_secret,
            secret_version_id: stateResult.secret_version_id,
        };
    }
}
