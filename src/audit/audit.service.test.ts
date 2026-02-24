import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { InMemoryControlPlaneStateStore } from '../persistence/in-memory-state-store';
import { FixedClock } from '../utils/clock';
import { AuditService } from './audit.service';

test('AuditService emits normalized cross-service audit events', async () => {
    const clock = new FixedClock('2026-02-18T10:00:00.000Z');
    const service = new AuditService(
        clock,
        new InMemoryControlPlaneStateStore(),
    );

    const legacyEvent = await service.record({
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

    const crossServiceEvents = await service.listCrossService();

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

test('AuditService cross-service list is replay ordered and limit aware', async () => {
    const clock = new FixedClock('2026-02-18T10:00:00.000Z');
    const service = new AuditService(
        clock,
        new InMemoryControlPlaneStateStore(),
    );

    await service.record({
        event_type: 'token_minted',
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        metadata: {},
    });

    clock.set('2026-02-18T10:00:05.000Z');
    await service.record({
        event_type: 'token_validate_denied',
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        deny_reason_code: 'denied_token_wrong_service_scope',
        metadata: {},
    });

    const ordered = await service.listCrossService();

    assert.equal(ordered.length, 2);
    assert.equal(ordered[0].action, 'token_minted');
    assert.equal(ordered[1].action, 'token_validate_denied');
    assert.equal(ordered[1].outcome, 'denied');
    assert.equal(
        ordered[1].reason_code,
        'denied_token_wrong_service_scope',
    );

    const limited = await service.listCrossService(1);

    assert.equal(limited.length, 1);
    assert.equal(limited[0].action, 'token_validate_denied');
});

test('AuditService preserves secret_version_id values while redacting actual secrets', async () => {
    const clock = new FixedClock('2026-02-18T10:00:00.000Z');
    const service = new AuditService(
        clock,
        new InMemoryControlPlaneStateStore(),
    );

    const event = await service.record({
        event_type: 'secret_rotation_completed',
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        metadata: {
            secret_version_id: 'sv_1',
            next_secret_version_id: 'sv_2',
            old_secret_version_id: 'sv_1',
            new_secret_version_id: 'sv_2',
            current_secret_version_id: 'sv_1',
            client_secret: 'sec_should_be_redacted',
            overlap_expires_at: '2026-02-18T11:00:00.000Z',
        },
    });

    assert.equal(event.metadata.secret_version_id, 'sv_1');
    assert.equal(event.metadata.next_secret_version_id, 'sv_2');
    assert.equal(event.metadata.old_secret_version_id, 'sv_1');
    assert.equal(event.metadata.new_secret_version_id, 'sv_2');
    assert.equal(event.metadata.current_secret_version_id, 'sv_1');
    assert.equal(event.metadata.client_secret, '[REDACTED]');
    assert.equal(
        event.metadata.overlap_expires_at,
        '2026-02-18T11:00:00.000Z',
    );
});

// ──────────────────────────────────────────────────
// Stage 5 — Extended Coverage
// ──────────────────────────────────────────────────

describe('AuditService — extended coverage', () => {
    describe('record', () => {
        test('generates unique UUID event_id for each '
            + 'event', async () => {
            const clock = new FixedClock(
                '2026-02-18T10:00:00.000Z'
            );
            const svc = new AuditService(
                clock,
                new InMemoryControlPlaneStateStore()
            );
            const e1 = await svc.record({
                event_type: 'tenant_created',
                metadata: {},
            });
            const e2 = await svc.record({
                event_type: 'tenant_created',
                metadata: {},
            });
            assert.notEqual(e1.event_id, e2.event_id);
            assert.match(
                e1.event_id,
                /^[0-9a-f-]{36}$/
            );
        });

        test('sets occurred_at from clock', async () => {
            const clock = new FixedClock(
                '2026-03-01T08:30:00.000Z'
            );
            const svc = new AuditService(
                clock,
                new InMemoryControlPlaneStateStore()
            );
            const e = await svc.record({
                event_type: 'tenant_created',
                metadata: {},
            });
            assert.equal(
                e.occurred_at,
                '2026-03-01T08:30:00.000Z'
            );
        });

        test('clones metadata so external mutation is '
            + 'isolated', async () => {
            const clock = new FixedClock(
                '2026-02-18T10:00:00.000Z'
            );
            const svc = new AuditService(
                clock,
                new InMemoryControlPlaneStateStore()
            );
            const e = await svc.record({
                event_type: 'tenant_created',
                metadata: { key: 'value' },
            });
            e.metadata.key = 'changed';
            const events = await svc.list();
            assert.equal(
                events[0].metadata.key,
                'value'
            );
        });
    });

    describe('list', () => {
        test('returns empty array when no events '
            + 'recorded', async () => {
            const clock = new FixedClock(
                '2026-02-18T10:00:00.000Z'
            );
            const svc = new AuditService(
                clock,
                new InMemoryControlPlaneStateStore()
            );
            const events = await svc.list();
            assert.deepStrictEqual(events, []);
        });

        test('returns all events when limit is '
            + 'undefined', async () => {
            const clock = new FixedClock(
                '2026-02-18T10:00:00.000Z'
            );
            const svc = new AuditService(
                clock,
                new InMemoryControlPlaneStateStore()
            );
            await svc.record({
                event_type: 'tenant_created',
                metadata: {},
            });
            await svc.record({
                event_type: 'tenant_created',
                metadata: {},
            });
            const events = await svc.list();
            assert.equal(events.length, 2);
        });

        test('returns all events when limit exceeds '
            + 'total', async () => {
            const clock = new FixedClock(
                '2026-02-18T10:00:00.000Z'
            );
            const svc = new AuditService(
                clock,
                new InMemoryControlPlaneStateStore()
            );
            await svc.record({
                event_type: 'tenant_created',
                metadata: {},
            });
            const events = await svc.list(100);
            assert.equal(events.length, 1);
        });

        test('sorts events by occurred_at ascending',
            async () => {
            const clock = new FixedClock(
                '2026-02-18T10:00:00.000Z'
            );
            const svc = new AuditService(
                clock,
                new InMemoryControlPlaneStateStore()
            );
            clock.set('2026-02-18T12:00:00.000Z');
            await svc.record({
                event_type: 'tenant_state_changed',
                metadata: {},
            });
            clock.set('2026-02-18T08:00:00.000Z');
            await svc.record({
                event_type: 'tenant_created',
                metadata: {},
            });
            const events = await svc.list();
            assert.equal(
                events[0].event_type,
                'tenant_created'
            );
            assert.equal(
                events[1].event_type,
                'tenant_state_changed'
            );
        });
    });

    describe('listCrossService', () => {
        test('returns empty array when no events '
            + 'recorded', async () => {
            const clock = new FixedClock(
                '2026-02-18T10:00:00.000Z'
            );
            const svc = new AuditService(
                clock,
                new InMemoryControlPlaneStateStore()
            );
            const events = await svc.listCrossService();
            assert.deepStrictEqual(events, []);
        });
    });
});
