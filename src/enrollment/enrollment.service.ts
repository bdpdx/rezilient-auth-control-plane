import { AuditService } from '../audit/audit.service';
import { AuthDenyReasonCode } from '../constants';
import { RegistryService } from '../registry/registry.service';
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

export class EnrollmentService {
    private readonly records = new Map<string, EnrollmentCodeRecord>();

    private readonly codeHashToId = new Map<string, string>();

    constructor(
        private readonly registry: RegistryService,
        private readonly audit: AuditService,
        private readonly clock: Clock,
    ) {}

    issueEnrollmentCode(input: IssueEnrollmentCodeInput): IssueEnrollmentCodeResult {
        const tenant = this.registry.getTenant(input.tenant_id);
        const instance = this.registry.getInstance(input.instance_id);

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

        this.records.set(codeId, record);
        this.codeHashToId.set(codeHash, codeId);

        this.audit.record({
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

    exchangeEnrollmentCode(enrollmentCode: string): ExchangeEnrollmentCodeResult {
        const codeHash = sha256Hex(enrollmentCode);
        const codeId = this.codeHashToId.get(codeHash);

        if (!codeId) {
            this.audit.record({
                event_type: 'token_mint_denied',
                deny_reason_code: 'denied_invalid_enrollment_code',
                metadata: {
                    phase: 'enrollment_exchange',
                },
            });

            return {
                success: false,
                reason_code: 'denied_invalid_enrollment_code',
            };
        }

        const record = this.records.get(codeId);

        if (!record) {
            return {
                success: false,
                reason_code: 'denied_invalid_enrollment_code',
            };
        }

        if (record.used_at) {
            this.audit.record({
                event_type: 'token_mint_denied',
                tenant_id: record.tenant_id,
                instance_id: record.instance_id,
                deny_reason_code: 'denied_enrollment_code_used',
                metadata: {
                    phase: 'enrollment_exchange',
                    code_id: record.code_id,
                },
            });

            return {
                success: false,
                reason_code: 'denied_enrollment_code_used',
            };
        }

        const nowIso = this.clock.now().toISOString();

        if (nowIso > record.expires_at) {
            this.audit.record({
                event_type: 'token_mint_denied',
                tenant_id: record.tenant_id,
                instance_id: record.instance_id,
                deny_reason_code: 'denied_enrollment_code_expired',
                metadata: {
                    phase: 'enrollment_exchange',
                    code_id: record.code_id,
                },
            });

            return {
                success: false,
                reason_code: 'denied_enrollment_code_expired',
            };
        }

        const instance = this.registry.getInstance(record.instance_id);

        if (!instance) {
            return {
                success: false,
                reason_code: 'denied_invalid_enrollment_code',
            };
        }

        const clientId = `cli_${randomToken(12)}`;
        const clientSecret = `sec_${randomToken(32)}`;
        const previousSecretVersions =
            instance.client_credentials?.secret_versions ?? [];
        const highestVersion = previousSecretVersions.reduce(
            (max, secret) => Math.max(max, parseSecretVersionNumber(secret.version_id)),
            0,
        );
        const nextVersion = highestVersion + 1;
        const secretVersionId = `sv_${nextVersion}`;

        this.registry.setInitialCredentials({
            instance_id: instance.instance_id,
            client_id: clientId,
            version_id: secretVersionId,
            secret_hash: sha256Hex(clientSecret),
        });

        record.used_at = nowIso;

        this.audit.record({
            event_type: 'enrollment_code_exchanged',
            tenant_id: record.tenant_id,
            instance_id: record.instance_id,
            client_id: clientId,
            metadata: {
                code_id: record.code_id,
                secret_version_id: secretVersionId,
            },
        });

        return {
            success: true,
            tenant_id: record.tenant_id,
            instance_id: record.instance_id,
            client_id: clientId,
            client_secret: clientSecret,
            secret_version_id: secretVersionId,
        };
    }
}
