import { AuditService } from '../audit/audit.service';
import { AuthAuditEvent } from '../audit/types';
import { InMemoryControlPlaneStateStore } from '../persistence/in-memory-state-store';
import { ControlPlaneStateStore } from '../persistence/state-store';
import { randomToken } from '../utils/crypto';

const SALES_CONTACT_EMAIL = 'sales@rezilient.co';
const SALES_CONTACT_MESSAGE = 'Sales will follow up shortly with next steps.';

export interface ReportInstanceLaunchInput {
    instance_id: string;
    source: string;
    tenant_id?: string;
    idempotency_key?: string;
    app_version?: string;
    environment?: string;
    metadata?: Record<string, unknown>;
}

export interface ReportInstanceLaunchResult {
    status: 'recorded' | 'duplicate';
    reference_id: string;
    recorded_at: string;
}

export interface RegisterInstanceInterestInput {
    source: string;
    organization_name: string;
    contact_name: string;
    contact_email: string;
    contact_phone?: string;
    notes?: string;
    requested_by?: string;
    metadata?: Record<string, unknown>;
}

export interface RegisterInstanceInterestResult {
    status: 'received';
    reference_id: string;
    sales_contact: {
        email: string;
        message: string;
    };
}

function asObjectMetadata(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    return {
        ...(value as Record<string, unknown>),
    };
}

function eventIdempotencyKey(
    event: AuthAuditEvent,
): string | undefined {
    const metadata = asObjectMetadata(event.metadata);
    const key = metadata.idempotency_key;

    return typeof key === 'string' && key.length > 0 ? key : undefined;
}

function eventInstanceId(
    event: AuthAuditEvent,
): string | undefined {
    if (event.instance_id && event.instance_id.length > 0) {
        return event.instance_id;
    }

    const metadata = asObjectMetadata(event.metadata);
    const metadataInstanceId = metadata.instance_id;

    return typeof metadataInstanceId === 'string' &&
            metadataInstanceId.length > 0
        ? metadataInstanceId
        : undefined;
}

export class OnboardingService {
    constructor(
        private readonly audit: AuditService,
        private readonly stateStore: ControlPlaneStateStore =
            new InMemoryControlPlaneStateStore(),
    ) {}

    async reportInstanceLaunch(
        input: ReportInstanceLaunchInput,
    ): Promise<ReportInstanceLaunchResult> {
        const events = (await this.stateStore.read()).audit_events;
        const existing = events.find((event) => {
            if (event.event_type !== 'instance_launch_reported') {
                return false;
            }

            if (eventInstanceId(event) !== input.instance_id) {
                return false;
            }

            if (!input.idempotency_key) {
                return true;
            }

            return eventIdempotencyKey(event) === input.idempotency_key;
        });

        if (existing) {
            return {
                status: 'duplicate',
                reference_id: existing.event_id,
                recorded_at: existing.occurred_at,
            };
        }

        const recorded = await this.audit.record({
            event_type: 'instance_launch_reported',
            tenant_id: input.tenant_id,
            instance_id: input.tenant_id
                ? input.instance_id
                : undefined,
            metadata: {
                instance_id: input.instance_id,
                source: input.source,
                idempotency_key: input.idempotency_key,
                app_version: input.app_version,
                environment: input.environment,
                ...(input.metadata || {}),
            },
        });

        return {
            status: 'recorded',
            reference_id: recorded.event_id,
            recorded_at: recorded.occurred_at,
        };
    }

    async registerInstanceInterest(
        input: RegisterInstanceInterestInput,
    ): Promise<RegisterInstanceInterestResult> {
        const referenceId = `ir_${randomToken(10)}`;
        await this.audit.record({
            event_type: 'instance_interest_registered',
            actor: input.requested_by,
            metadata: {
                reference_id: referenceId,
                source: input.source,
                organization_name: input.organization_name,
                contact_name: input.contact_name,
                contact_email: input.contact_email,
                contact_phone: input.contact_phone,
                notes: input.notes,
                ...(input.metadata || {}),
            },
        });

        return {
            status: 'received',
            reference_id: referenceId,
            sales_contact: {
                email: SALES_CONTACT_EMAIL,
                message: SALES_CONTACT_MESSAGE,
            },
        };
    }
}
