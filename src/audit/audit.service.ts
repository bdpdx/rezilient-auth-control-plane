import { randomUUID } from 'node:crypto';
import {
    compareCrossServiceAuditEventsForReplay,
    CrossServiceAuditEvent,
    fromLegacyAuthAuditEvent,
} from '@rezilient/types';
import { InMemoryControlPlaneStateStore } from '../persistence/in-memory-state-store';
import { ControlPlaneStateStore } from '../persistence/state-store';
import { Clock } from '../utils/clock';
import {
    AuthAuditEvent,
    AuthAuditEventType,
} from './types';

interface RecordAuditEventInput {
    event_type: AuthAuditEventType;
    actor?: string;
    tenant_id?: string;
    instance_id?: string;
    client_id?: string;
    service_scope?: AuthAuditEvent['service_scope'];
    deny_reason_code?: AuthAuditEvent['deny_reason_code'];
    in_flight_reason_code?: AuthAuditEvent['in_flight_reason_code'];
    metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY_SNIPPETS = [
    'secret',
    'enrollment_code',
    'token',
];

function sanitizeMetadataValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeMetadataValue(entry));
    }

    if (value && typeof value === 'object') {
        const objectValue = value as Record<string, unknown>;
        const sanitized: Record<string, unknown> = {};

        for (const [key, nestedValue] of Object.entries(objectValue)) {
            const loweredKey = key.toLowerCase();
            const isSensitive = SENSITIVE_KEY_SNIPPETS.some((snippet) =>
                loweredKey.includes(snippet),
            );

            if (isSensitive) {
                sanitized[key] = '[REDACTED]';
                continue;
            }

            sanitized[key] = sanitizeMetadataValue(nestedValue);
        }

        return sanitized;
    }

    return value;
}

function cloneCrossServiceAuditEvent(
    event: CrossServiceAuditEvent,
): CrossServiceAuditEvent {
    return JSON.parse(
        JSON.stringify(event),
    ) as CrossServiceAuditEvent;
}

export class AuditService {
    constructor(
        private readonly clock: Clock,
        private readonly stateStore: ControlPlaneStateStore =
            new InMemoryControlPlaneStateStore(),
    ) {}

    async record(input: RecordAuditEventInput): Promise<AuthAuditEvent> {
        const event: AuthAuditEvent = {
            event_id: randomUUID(),
            event_type: input.event_type,
            occurred_at: this.clock.now().toISOString(),
            actor: input.actor,
            tenant_id: input.tenant_id,
            instance_id: input.instance_id,
            client_id: input.client_id,
            service_scope: input.service_scope,
            deny_reason_code: input.deny_reason_code,
            in_flight_reason_code: input.in_flight_reason_code,
            metadata: (sanitizeMetadataValue(input.metadata || {}) as
                Record<string, unknown>),
        };
        const crossServiceEvent = fromLegacyAuthAuditEvent(event);

        return await this.stateStore.mutate((state) => {
            state.audit_events.push(event);
            state.cross_service_audit_events.push(crossServiceEvent);

            return {
                ...event,
                metadata: {
                    ...event.metadata,
                },
            };
        });
    }

    async list(limit?: number): Promise<AuthAuditEvent[]> {
        const ordered = (await this.stateStore.read()).audit_events
            .slice()
            .sort((left, right) =>
                left.occurred_at.localeCompare(right.occurred_at),
            );

        if (limit === undefined) {
            return ordered.map((event) => ({
                ...event,
                metadata: {
                    ...event.metadata,
                },
            }));
        }

        return ordered.slice(-limit).map((event) => ({
            ...event,
            metadata: {
                ...event.metadata,
            },
        }));
    }

    async listCrossService(limit?: number): Promise<CrossServiceAuditEvent[]> {
        const ordered = (await this.stateStore.read()).cross_service_audit_events
            .slice()
            .sort((left, right) =>
                compareCrossServiceAuditEventsForReplay(left, right)
            );

        if (limit === undefined) {
            return ordered.map((event) => cloneCrossServiceAuditEvent(event));
        }

        return ordered
            .slice(-limit)
            .map((event) => cloneCrossServiceAuditEvent(event));
    }
}
