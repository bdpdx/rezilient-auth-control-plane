import { describe, test } from 'node:test';
import assert from 'node:assert';
import { InMemoryControlPlaneStateStore } from './in-memory-state-store';

describe('InMemoryControlPlaneStateStore', () => {
    test('read returns clone of initial empty state', async () => {
        const store = new InMemoryControlPlaneStateStore();
        const state = await store.read();
        assert.deepStrictEqual(state.tenants, {});
        assert.strictEqual(state.outage_active, false);
    });

    test('mutations to read result do not affect stored '
        + 'state', async () => {
        const store = new InMemoryControlPlaneStateStore();
        const state = await store.read();
        state.outage_active = true;
        const fresh = await store.read();
        assert.strictEqual(fresh.outage_active, false);
    });

    test('mutate applies function and returns its '
        + 'result', async () => {
        const store = new InMemoryControlPlaneStateStore();
        const result = await store.mutate((s) => {
            s.outage_active = true;
            return 'done';
        });
        assert.strictEqual(result, 'done');
    });

    test('state persists across multiple reads after '
        + 'mutation', async () => {
        const store = new InMemoryControlPlaneStateStore();
        await store.mutate((s) => {
            s.outage_active = true;
        });
        const s1 = await store.read();
        const s2 = await store.read();
        assert.strictEqual(s1.outage_active, true);
        assert.strictEqual(s2.outage_active, true);
    });

    test('mutate rolls back state when mutator '
        + 'throws', async () => {
        const store = new InMemoryControlPlaneStateStore();
        await store.mutate((s) => {
            s.outage_active = true;
        });
        try {
            await store.mutate((s) => {
                s.outage_active = false;
                throw new Error('boom');
            });
        } catch {
            // expected
        }
        const state = await store.read();
        // The in-memory store applies mutation to a clone
        // then replaces. If the mutator throws after
        // modifying the clone, the store still replaces
        // state with the modified clone. Let's verify
        // actual behavior.
        // Looking at the source: mutate clones first, runs
        // mutator on clone, then sets this.state = clone.
        // If mutator throws, the assignment still happens
        // because there's no try/catch. Actually, let me
        // re-read: the await mutator(...) can throw, and
        // the next line this.state = workingState won't
        // execute. So rollback IS correct.
        assert.strictEqual(state.outage_active, true);
    });

    test('sequential mutations accumulate', async () => {
        const store = new InMemoryControlPlaneStateStore();
        await store.mutate((s) => {
            s.tenants['t1'] = {
                tenant_id: 't1',
                state: 'active',
                entitlement_state: 'active',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
            } as any;
        });
        await store.mutate((s) => {
            s.tenants['t2'] = {
                tenant_id: 't2',
                state: 'active',
                entitlement_state: 'active',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
            } as any;
        });
        const state = await store.read();
        assert.ok('t1' in state.tenants);
        assert.ok('t2' in state.tenants);
    });

    test('close resolves without error', async () => {
        const store = new InMemoryControlPlaneStateStore();
        await assert.doesNotReject(() => store.close());
    });

    test('read after mutate reflects changes', async () => {
        const store = new InMemoryControlPlaneStateStore();
        await store.mutate((s) => {
            s.outage_active = true;
            s.audit_events.push({
                event_id: 'e1',
                event_type: 'test',
                occurred_at: '2026-01-01T00:00:00.000Z',
                metadata: {},
            } as any);
        });
        const state = await store.read();
        assert.strictEqual(state.outage_active, true);
        assert.strictEqual(state.audit_events.length, 1);
        assert.strictEqual(
            state.audit_events[0].event_id,
            'e1'
        );
    });
});
