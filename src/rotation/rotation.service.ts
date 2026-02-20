import { AuditService } from '../audit/audit.service';
import { RegistryService } from '../registry/registry.service';
import { Clock } from '../utils/clock';
import {
    randomToken,
    sha256Hex,
} from '../utils/crypto';

interface StartRotationInput {
    instance_id: string;
    requested_by?: string;
    overlap_seconds: number;
}

interface StartRotationResult {
    instance_id: string;
    next_secret_version_id: string;
    next_client_secret: string;
    overlap_expires_at: string;
}

interface CompleteRotationInput {
    instance_id: string;
    requested_by?: string;
}

interface CompleteRotationResult {
    instance_id: string;
    old_secret_version_id: string;
    new_secret_version_id: string;
}

interface RevokeSecretInput {
    instance_id: string;
    secret_version_id: string;
    requested_by?: string;
    reason?: string;
}

interface NextVersionInfo {
    version_id: string;
    sequence: number;
}

function nextSecretVersion(existingVersionIds: string[]): NextVersionInfo {
    const sequence = existingVersionIds.reduce((max, versionId) => {
        if (!versionId.startsWith('sv_')) {
            return max;
        }

        const parsed = Number(versionId.slice(3));

        if (Number.isNaN(parsed)) {
            return max;
        }

        return Math.max(max, parsed);
    }, 0) + 1;

    return {
        version_id: `sv_${sequence}`,
        sequence,
    };
}

export class RotationService {
    constructor(
        private readonly registry: RegistryService,
        private readonly audit: AuditService,
        private readonly clock: Clock,
    ) {}

    async startRotation(
        input: StartRotationInput,
    ): Promise<StartRotationResult> {
        const instance = await this.registry.getInstance(input.instance_id);

        if (!instance || !instance.client_credentials) {
            throw new Error('instance has no credentials to rotate');
        }

        if (instance.client_credentials.next_secret_version_id) {
            throw new Error('rotation already in progress');
        }

        const nextVersion = nextSecretVersion(
            instance.client_credentials.secret_versions.map((entry) => entry.version_id),
        );
        const nextClientSecret = `sec_${randomToken(32)}`;
        const now = this.clock.now();
        const overlapExpiresAt = new Date(
            now.getTime() + (input.overlap_seconds * 1000),
        ).toISOString();

        await this.registry.addNextSecretVersion({
            instance_id: input.instance_id,
            version_id: nextVersion.version_id,
            secret_hash: sha256Hex(nextClientSecret),
            valid_until: overlapExpiresAt,
        });

        await this.audit.record({
            event_type: 'secret_rotation_started',
            actor: input.requested_by,
            tenant_id: instance.tenant_id,
            instance_id: instance.instance_id,
            client_id: instance.client_credentials.client_id,
            metadata: {
                next_secret_version_id: nextVersion.version_id,
                overlap_expires_at: overlapExpiresAt,
            },
        });

        return {
            instance_id: instance.instance_id,
            next_secret_version_id: nextVersion.version_id,
            next_client_secret: nextClientSecret,
            overlap_expires_at: overlapExpiresAt,
        };
    }

    async recordAdoption(
        instanceId: string,
        secretVersionId: string,
    ): Promise<void> {
        const before = await this.registry.getInstance(instanceId);

        if (!before || !before.client_credentials) {
            return;
        }

        const secret = before.client_credentials.secret_versions.find(
            (entry) => entry.version_id === secretVersionId,
        );

        if (!secret || secret.adopted_at) {
            return;
        }

        const updated = await this.registry.markSecretAdopted(
            instanceId,
            secretVersionId,
        );

        await this.audit.record({
            event_type: 'secret_rotation_adopted',
            tenant_id: updated.tenant_id,
            instance_id: updated.instance_id,
            client_id: updated.client_credentials?.client_id,
            metadata: {
                secret_version_id: secretVersionId,
            },
        });
    }

    async completeRotation(
        input: CompleteRotationInput,
    ): Promise<CompleteRotationResult> {
        const promoted = await this.registry.promoteNextSecret(input.instance_id);

        await this.audit.record({
            event_type: 'secret_rotation_completed',
            actor: input.requested_by,
            tenant_id: promoted.instance.tenant_id,
            instance_id: promoted.instance.instance_id,
            client_id: promoted.instance.client_credentials?.client_id,
            metadata: {
                old_secret_version_id: promoted.old_secret_version_id,
                new_secret_version_id: promoted.new_secret_version_id,
            },
        });

        return {
            instance_id: promoted.instance.instance_id,
            old_secret_version_id: promoted.old_secret_version_id,
            new_secret_version_id: promoted.new_secret_version_id,
        };
    }

    async revokeSecret(input: RevokeSecretInput): Promise<void> {
        const updated = await this.registry.revokeSecretVersion(
            input.instance_id,
            input.secret_version_id,
        );

        await this.audit.record({
            event_type: 'secret_revoked',
            actor: input.requested_by,
            tenant_id: updated.tenant_id,
            instance_id: updated.instance_id,
            client_id: updated.client_credentials?.client_id,
            metadata: {
                secret_version_id: input.secret_version_id,
                reason: input.reason,
            },
        });
    }
}
