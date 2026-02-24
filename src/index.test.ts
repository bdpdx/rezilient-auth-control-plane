import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { createInMemoryControlPlane } from './index';
import { FixedClock } from './utils/clock';

describe('createInMemoryControlPlane', () => {
    test('returns ControlPlane with all services', () => {
        const cp = createInMemoryControlPlane(
            new FixedClock('2026-02-16T12:00:00.000Z'),
            {
                issuer: 'test-issuer',
                signing_key:
                    'test-key-0123456789abcdef01234567',
                token_ttl_seconds: 300,
                token_clock_skew_seconds: 30,
                outage_grace_window_seconds: 120,
            }
        );
        assert.ok(cp.services.registry);
        assert.ok(cp.services.enrollment);
        assert.ok(cp.services.rotation);
        assert.ok(cp.services.token);
        assert.ok(cp.services.audit);
        assert.ok(cp.state_store);
        assert.ok(typeof cp.close === 'function');
    });

    test('uses custom clock when provided', async () => {
        const clock = new FixedClock(
            '2026-06-01T00:00:00.000Z'
        );
        const cp = createInMemoryControlPlane(clock, {
            issuer: 'test-issuer',
            signing_key:
                'test-key-0123456789abcdef01234567',
            token_ttl_seconds: 300,
            token_clock_skew_seconds: 30,
            outage_grace_window_seconds: 120,
        });

        await cp.services.registry.createTenant({
            tenant_id: 't1',
            name: 'T1',
        });
        const tenant =
            await cp.services.registry.getTenant('t1');
        assert.ok(tenant);
        assert.equal(
            tenant.created_at,
            '2026-06-01T00:00:00.000Z'
        );
    });

    test('uses custom token config when provided',
        () => {
        const cp = createInMemoryControlPlane(
            new FixedClock('2026-02-16T12:00:00.000Z'),
            {
                issuer: 'custom-iss',
                signing_key:
                    'custom-key-0123456789abcdef0123',
                token_ttl_seconds: 900,
                token_clock_skew_seconds: 60,
                outage_grace_window_seconds: 240,
            }
        );
        assert.equal(
            cp.token_config.issuer,
            'custom-iss'
        );
        assert.equal(
            cp.token_config.token_ttl_seconds,
            900
        );
        assert.equal(
            cp.token_config.token_clock_skew_seconds,
            60
        );
        assert.equal(
            cp.token_config.outage_grace_window_seconds,
            240
        );
    });
});
