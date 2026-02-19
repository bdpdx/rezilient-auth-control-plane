import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { InMemoryControlPlaneStateStore } from '../persistence/in-memory-state-store';
import { FixedClock } from '../utils/clock';
import { AuditService } from './audit.service';

test('AuditService emits normalized cross-service audit events', () => {
    const clock = new FixedClock('2026-02-18T10:00:00.000Z');
    const service = new AuditService(
        clock,
        new InMemoryControlPlaneStateStore(),
    );

    const legacyEvent = service.record({
        event_type: 'token_minted',
        actor: 'svc:acp-token-service',
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        client_id: 'client-1',
        service_scope: 'reg',
        metadata: {
            request_id: 'req-123',
            token_preview: 'abc123',
            nested: {
                client_secret: 'super-secret',
            },
        },
    });

    assert.equal(legacyEvent.metadata.token_preview, '[REDACTED]');
    const nested = legacyEvent.metadata.nested as Record<string, unknown>;
    assert.equal(nested.client_secret, '[REDACTED]');

    const crossServiceEvents = service.listCrossService();

    assert.equal(crossServiceEvents.length, 1);
    assert.equal(
        crossServiceEvents[0].contract_version,
        'audit.contracts.v1',
    );
    assert.equal(crossServiceEvents[0].schema_version, 'audit.event.v1');
    assert.equal(crossServiceEvents[0].service, 'acp');
    assert.equal(crossServiceEvents[0].lifecycle, 'auth');
    assert.equal(crossServiceEvents[0].action, 'token_minted');
    assert.equal(crossServiceEvents[0].outcome, 'accepted');
    assert.equal(crossServiceEvents[0].tenant_id, 'tenant-acme');
    assert.equal(crossServiceEvents[0].instance_id, 'instance-dev-01');
    assert.equal(crossServiceEvents[0].actor?.type, 'service');
    assert.equal(crossServiceEvents[0].actor?.id, 'svc:acp-token-service');
    assert.equal(crossServiceEvents[0].metadata.client_id, 'client-1');
    assert.equal(crossServiceEvents[0].metadata.service_scope, 'reg');
});

test('AuditService cross-service list is replay ordered and limit aware', () => {
    const clock = new FixedClock('2026-02-18T10:00:00.000Z');
    const service = new AuditService(
        clock,
        new InMemoryControlPlaneStateStore(),
    );

    service.record({
        event_type: 'token_minted',
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        metadata: {},
    });

    clock.set('2026-02-18T10:00:05.000Z');
    service.record({
        event_type: 'token_validate_denied',
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        deny_reason_code: 'denied_token_wrong_service_scope',
        metadata: {},
    });

    const ordered = service.listCrossService();

    assert.equal(ordered.length, 2);
    assert.equal(ordered[0].action, 'token_minted');
    assert.equal(ordered[1].action, 'token_validate_denied');
    assert.equal(ordered[1].outcome, 'denied');
    assert.equal(
        ordered[1].reason_code,
        'denied_token_wrong_service_scope',
    );

    const limited = service.listCrossService(1);

    assert.equal(limited.length, 1);
    assert.equal(limited[0].action, 'token_validate_denied');
});
