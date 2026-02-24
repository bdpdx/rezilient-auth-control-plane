import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
    createEmptyControlPlaneState,
    cloneControlPlaneState,
} from './types';

describe('createEmptyControlPlaneState', () => {
    test('returns object with all required keys', () => {
        const state = createEmptyControlPlaneState();
        const keys = [
            'tenants',
            'instances',
            'client_id_to_instance',
            'enrollment_records',
            'code_hash_to_id',
            'audit_events',
            'cross_service_audit_events',
            'outage_active',
        ];
        for (const key of keys) {
            assert.ok(
                key in state,
                `missing key: ${key}`
            );
        }
    });

    test('all collections are empty', () => {
        const state = createEmptyControlPlaneState();
        assert.deepStrictEqual(state.tenants, {});
        assert.deepStrictEqual(state.instances, {});
        assert.deepStrictEqual(
            state.client_id_to_instance,
            {}
        );
        assert.deepStrictEqual(
            state.enrollment_records,
            {}
        );
        assert.deepStrictEqual(state.code_hash_to_id, {});
        assert.deepStrictEqual(state.audit_events, []);
        assert.deepStrictEqual(
            state.cross_service_audit_events,
            []
        );
    });

    test('outage_active is false', () => {
        const state = createEmptyControlPlaneState();
        assert.strictEqual(state.outage_active, false);
    });
});

describe('cloneControlPlaneState', () => {
    test('produces deep copy independent of original', () => {
        const original = createEmptyControlPlaneState();
        original.outage_active = true;
        const cloned = cloneControlPlaneState(original);
        cloned.outage_active = false;
        assert.strictEqual(original.outage_active, true);
    });

    test('preserves all nested data structures', () => {
        const original = createEmptyControlPlaneState();
        original.tenants['t1'] = {
            tenant_id: 't1',
            state: 'active',
            entitlement_state: 'active',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
        } as any;
        original.audit_events.push({
            event_id: 'e1',
            event_type: 'tenant_created',
            occurred_at: '2026-01-01T00:00:00.000Z',
            metadata: { tenant_id: 't1' },
        } as any);
        const cloned = cloneControlPlaneState(original);
        assert.deepStrictEqual(
            cloned.tenants['t1'],
            original.tenants['t1']
        );
        assert.deepStrictEqual(
            cloned.audit_events,
            original.audit_events
        );
        // Verify independence
        cloned.tenants['t1'].state = 'disabled' as any;
        assert.strictEqual(
            original.tenants['t1'].state,
            'active'
        );
    });
});
