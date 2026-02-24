import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
    createFixture,
    TestFixture,
} from '../test-helpers';
import { RegistryService } from './registry.service';
import { sha256Hex } from '../utils/crypto';

let fixture: TestFixture;
let registry: RegistryService;

async function freshFixture(): Promise<void> {
    fixture = createFixture();
    registry = fixture.control_plane.services.registry;
}

// ──────────────────────────────────────────────────
// Stage 3 — Tenant Operations
// ──────────────────────────────────────────────────

describe('RegistryService — Tenant Operations', () => {
    beforeEach(async () => freshFixture());

    describe('createTenant', () => {
        test('creates tenant with default state and '
            + 'entitlement', async () => {
            const t = await registry.createTenant({
                tenant_id: 't1',
                name: 'Tenant One',
            });
            assert.strictEqual(t.tenant_id, 't1');
            assert.strictEqual(t.state, 'active');
            assert.strictEqual(
                t.entitlement_state,
                'active'
            );
        });

        test('creates tenant with explicit state and '
            + 'entitlement', async () => {
            const t = await registry.createTenant({
                tenant_id: 't1',
                name: 'Tenant One',
                state: 'suspended',
                entitlement_state: 'disabled',
            });
            assert.strictEqual(t.state, 'suspended');
            assert.strictEqual(
                t.entitlement_state,
                'disabled'
            );
        });

        test('rejects duplicate tenant_id', async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'First',
            });
            await assert.rejects(
                () => registry.createTenant({
                    tenant_id: 't1',
                    name: 'Dup',
                }),
                /already exists/
            );
        });

        test('emits tenant_created audit event',
            async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
            });
            const events =
                await fixture.control_plane
                    .services.audit.list();
            const evt = events.find(
                (e) => e.event_type === 'tenant_created'
            );
            assert.ok(evt);
            assert.strictEqual(evt.tenant_id, 't1');
        });

        test('stores created_at and updated_at '
            + 'timestamps', async () => {
            const t = await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
            });
            assert.ok(t.created_at);
            assert.ok(t.updated_at);
            assert.strictEqual(t.created_at, t.updated_at);
        });

        test('rejects invalid state enum value',
            async () => {
            await assert.rejects(
                () => registry.createTenant({
                    tenant_id: 't1',
                    name: 'T',
                    state: 'bogus' as any,
                }),
                /invalid tenant state/
            );
        });

        test('rejects invalid entitlement_state enum '
            + 'value', async () => {
            await assert.rejects(
                () => registry.createTenant({
                    tenant_id: 't1',
                    name: 'T',
                    entitlement_state: 'bogus' as any,
                }),
                /invalid entitlement state/
            );
        });
    });

    describe('setTenantState', () => {
        test('transitions active to suspended',
            async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
            });
            const t = await registry.setTenantState(
                't1',
                'suspended'
            );
            assert.strictEqual(t.state, 'suspended');
        });

        test('transitions suspended to disabled',
            async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
                state: 'suspended',
            });
            const t = await registry.setTenantState(
                't1',
                'disabled'
            );
            assert.strictEqual(t.state, 'disabled');
        });

        test('transitions disabled to active',
            async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
                state: 'disabled',
            });
            const t = await registry.setTenantState(
                't1',
                'active'
            );
            assert.strictEqual(t.state, 'active');
        });

        test('rejects unknown tenant_id', async () => {
            await assert.rejects(
                () => registry.setTenantState(
                    'missing',
                    'active'
                ),
                /tenant not found/
            );
        });

        test('rejects invalid state value', async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
            });
            await assert.rejects(
                () => registry.setTenantState(
                    't1',
                    'bogus' as any
                ),
                /invalid tenant state/
            );
        });

        test('emits tenant_state_changed audit event',
            async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
            });
            await registry.setTenantState(
                't1',
                'suspended'
            );
            const events =
                await fixture.control_plane
                    .services.audit.list();
            const evt = events.find(
                (e) =>
                    e.event_type === 'tenant_state_changed'
            );
            assert.ok(evt);
            assert.strictEqual(evt.tenant_id, 't1');
        });
    });

    describe('setTenantEntitlement', () => {
        test('transitions active to disabled',
            async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
            });
            const t = await registry.setTenantEntitlement(
                't1',
                'disabled'
            );
            assert.strictEqual(
                t.entitlement_state,
                'disabled'
            );
        });

        test('rejects unknown tenant_id', async () => {
            await assert.rejects(
                () => registry.setTenantEntitlement(
                    'missing',
                    'active'
                ),
                /tenant not found/
            );
        });

        test('emits tenant_entitlement_changed audit '
            + 'event', async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
            });
            await registry.setTenantEntitlement(
                't1',
                'disabled'
            );
            const events =
                await fixture.control_plane
                    .services.audit.list();
            const evt = events.find(
                (e) => e.event_type ===
                    'tenant_entitlement_changed'
            );
            assert.ok(evt);
        });
    });

    describe('getTenant', () => {
        test('returns tenant record when found',
            async () => {
            await registry.createTenant({
                tenant_id: 't1',
                name: 'T',
            });
            const t = await registry.getTenant('t1');
            assert.ok(t);
            assert.strictEqual(t.tenant_id, 't1');
        });

        test('returns undefined when not found',
            async () => {
            const t = await registry.getTenant('nope');
            assert.strictEqual(t, undefined);
        });
    });

    describe('listTenants', () => {
        test('returns empty array with no tenants',
            async () => {
            const list = await registry.listTenants();
            assert.deepStrictEqual(list, []);
        });

        test('returns tenants sorted by ID',
            async () => {
            await registry.createTenant({
                tenant_id: 'z-last',
                name: 'Z',
            });
            await registry.createTenant({
                tenant_id: 'a-first',
                name: 'A',
            });
            const list = await registry.listTenants();
            assert.strictEqual(
                list[0].tenant_id,
                'a-first'
            );
            assert.strictEqual(
                list[1].tenant_id,
                'z-last'
            );
        });
    });
});

// ──────────────────────────────────────────────────
// Stage 4 — Instance Operations
// ──────────────────────────────────────────────────

describe('RegistryService — Instance Operations', () => {
    beforeEach(async () => {
        await freshFixture();
        await registry.createTenant({
            tenant_id: 't1',
            name: 'T',
        });
    });

    describe('createInstance', () => {
        test('creates instance with default state and '
            + 'services', async () => {
            const inst = await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            assert.strictEqual(inst.instance_id, 'i1');
            assert.strictEqual(inst.state, 'active');
            assert.deepStrictEqual(
                inst.allowed_services,
                ['reg', 'rrs']
            );
        });

        test('creates instance with explicit state and '
            + 'services', async () => {
            const inst = await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
                state: 'suspended',
                allowed_services: ['reg'],
            });
            assert.strictEqual(inst.state, 'suspended');
            assert.deepStrictEqual(
                inst.allowed_services,
                ['reg']
            );
        });

        test('rejects unknown tenant_id', async () => {
            await assert.rejects(
                () => registry.createInstance({
                    instance_id: 'i1',
                    tenant_id: 'missing',
                    source: 'sn://dev.service-now.com',
                }),
                /tenant not found/
            );
        });

        test('rejects duplicate instance_id', async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev1.service-now.com',
            });
            await assert.rejects(
                () => registry.createInstance({
                    instance_id: 'i1',
                    tenant_id: 't1',
                    source: 'sn://dev2.service-now.com',
                }),
                /already exists/
            );
        });

        test('rejects duplicate source mapping',
            async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            await assert.rejects(
                () => registry.createInstance({
                    instance_id: 'i2',
                    tenant_id: 't1',
                    source: 'sn://dev.service-now.com',
                }),
                /source mapping already exists/
            );
        });

        test('validates service scope values',
            async () => {
            await assert.rejects(
                () => registry.createInstance({
                    instance_id: 'i1',
                    tenant_id: 't1',
                    source: 'sn://dev.service-now.com',
                    allowed_services: ['bogus'] as any,
                }),
                /invalid service scope/
            );
        });

        test('emits instance_created audit event',
            async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            const events =
                await fixture.control_plane
                    .services.audit.list();
            const evt = events.find(
                (e) => e.event_type === 'instance_created'
            );
            assert.ok(evt);
            assert.strictEqual(evt.instance_id, 'i1');
        });
    });

    describe('setInstanceState', () => {
        test('transitions active to suspended',
            async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            const inst = await registry.setInstanceState(
                'i1',
                'suspended'
            );
            assert.strictEqual(inst.state, 'suspended');
        });

        test('rejects unknown instance_id', async () => {
            await assert.rejects(
                () => registry.setInstanceState(
                    'missing',
                    'active'
                ),
                /instance not found/
            );
        });

        test('emits instance_state_changed audit event',
            async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            await registry.setInstanceState(
                'i1',
                'suspended'
            );
            const events =
                await fixture.control_plane
                    .services.audit.list();
            const evt = events.find(
                (e) => e.event_type ===
                    'instance_state_changed'
            );
            assert.ok(evt);
        });
    });

    describe('setInstanceAllowedServices', () => {
        test('updates allowed services list',
            async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            const inst =
                await registry.setInstanceAllowedServices(
                    'i1',
                    ['rrs']
                );
            assert.deepStrictEqual(
                inst.allowed_services,
                ['rrs']
            );
        });

        test('deduplicates and sorts services',
            async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            const inst =
                await registry.setInstanceAllowedServices(
                    'i1',
                    ['rrs', 'reg', 'rrs']
                );
            assert.deepStrictEqual(
                inst.allowed_services,
                ['reg', 'rrs']
            );
        });

        test('rejects unknown instance_id', async () => {
            await assert.rejects(
                () =>
                    registry.setInstanceAllowedServices(
                        'missing',
                        ['reg']
                    ),
                /instance not found/
            );
        });

        test('validates all service scope values',
            async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            await assert.rejects(
                () =>
                    registry.setInstanceAllowedServices(
                        'i1',
                        ['bad'] as any
                    ),
                /invalid service scope/
            );
        });

        test('emits instance_services_updated audit '
            + 'event', async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            await registry.setInstanceAllowedServices(
                'i1',
                ['reg']
            );
            const events =
                await fixture.control_plane
                    .services.audit.list();
            const evt = events.find(
                (e) => e.event_type ===
                    'instance_services_updated'
            );
            assert.ok(evt);
        });
    });

    describe('getInstance', () => {
        test('returns instance when found', async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            const inst = await registry.getInstance('i1');
            assert.ok(inst);
            assert.strictEqual(inst.instance_id, 'i1');
        });

        test('returns undefined when not found',
            async () => {
            const inst = await registry.getInstance(
                'nope'
            );
            assert.strictEqual(inst, undefined);
        });
    });

    describe('listInstances', () => {
        test('returns empty array with no instances',
            async () => {
            const list =
                await registry.listInstances();
            assert.deepStrictEqual(list, []);
        });

        test('returns instances sorted by ID',
            async () => {
            await registry.createInstance({
                instance_id: 'z-inst',
                tenant_id: 't1',
                source: 'sn://z.service-now.com',
            });
            await registry.createInstance({
                instance_id: 'a-inst',
                tenant_id: 't1',
                source: 'sn://a.service-now.com',
            });
            const list =
                await registry.listInstances();
            assert.strictEqual(
                list[0].instance_id,
                'a-inst'
            );
            assert.strictEqual(
                list[1].instance_id,
                'z-inst'
            );
        });
    });

    describe('getInstanceByClientId', () => {
        test('returns instance after enrollment',
            async () => {
            await registry.createInstance({
                instance_id: 'i1',
                tenant_id: 't1',
                source: 'sn://dev.service-now.com',
            });
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('secret'),
            });
            const inst =
                await registry.getInstanceByClientId(
                    'cli_abc'
                );
            assert.ok(inst);
            assert.strictEqual(inst.instance_id, 'i1');
        });

        test('returns undefined for unknown client_id',
            async () => {
            const inst =
                await registry.getInstanceByClientId(
                    'nope'
                );
            assert.strictEqual(inst, undefined);
        });
    });
});

// ──────────────────────────────────────────────────
// Stage 4 — Credential Operations
// ──────────────────────────────────────────────────

describe('RegistryService — Credential Operations', () => {
    beforeEach(async () => {
        await freshFixture();
        await registry.createTenant({
            tenant_id: 't1',
            name: 'T',
        });
        await registry.createInstance({
            instance_id: 'i1',
            tenant_id: 't1',
            source: 'sn://dev.service-now.com',
        });
    });

    describe('setInitialCredentials', () => {
        test('sets credentials on instance', async () => {
            const inst =
                await registry.setInitialCredentials({
                    instance_id: 'i1',
                    client_id: 'cli_abc',
                    version_id: 'sv_0',
                    secret_hash: sha256Hex('secret'),
                });
            assert.ok(inst.client_credentials);
            assert.strictEqual(
                inst.client_credentials.client_id,
                'cli_abc'
            );
            assert.strictEqual(
                inst.client_credentials
                    .current_secret_version_id,
                'sv_0'
            );
        });

        test('registers client_id to instance mapping',
            async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('secret'),
            });
            const inst =
                await registry.getInstanceByClientId(
                    'cli_abc'
                );
            assert.ok(inst);
            assert.strictEqual(inst.instance_id, 'i1');
        });

        test('rejects unknown instance', async () => {
            await assert.rejects(
                () => registry.setInitialCredentials({
                    instance_id: 'missing',
                    client_id: 'cli_abc',
                    version_id: 'sv_0',
                    secret_hash: sha256Hex('secret'),
                }),
                /instance not found/
            );
        });

        test('rejects when credentials already exist',
            async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('secret'),
            });
            await assert.rejects(
                () => registry.setInitialCredentials({
                    instance_id: 'i1',
                    client_id: 'cli_def',
                    version_id: 'sv_1',
                    secret_hash: sha256Hex('secret2'),
                }),
                /already has credentials/
            );
        });
    });

    describe('addNextSecretVersion', () => {
        test('adds next secret version', async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('secret0'),
            });
            const inst =
                await registry.addNextSecretVersion({
                    instance_id: 'i1',
                    version_id: 'sv_1',
                    secret_hash: sha256Hex('secret1'),
                });
            assert.ok(inst.client_credentials);
            assert.strictEqual(
                inst.client_credentials
                    .next_secret_version_id,
                'sv_1'
            );
        });

        test('rejects when no credentials exist',
            async () => {
            await assert.rejects(
                () => registry.addNextSecretVersion({
                    instance_id: 'i1',
                    version_id: 'sv_1',
                    secret_hash: sha256Hex('s'),
                }),
                /no client credentials/
            );
        });

        test('rejects when rotation already in '
            + 'progress', async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('s0'),
            });
            await registry.addNextSecretVersion({
                instance_id: 'i1',
                version_id: 'sv_1',
                secret_hash: sha256Hex('s1'),
            });
            await assert.rejects(
                () => registry.addNextSecretVersion({
                    instance_id: 'i1',
                    version_id: 'sv_2',
                    secret_hash: sha256Hex('s2'),
                }),
                /rotation already in progress/
            );
        });
    });

    describe('markSecretAdopted', () => {
        test('sets adopted_at on secret version',
            async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('s0'),
            });
            await registry.addNextSecretVersion({
                instance_id: 'i1',
                version_id: 'sv_1',
                secret_hash: sha256Hex('s1'),
            });
            const inst =
                await registry.markSecretAdopted(
                    'i1',
                    'sv_1'
                );
            const sv1 =
                inst.client_credentials!
                    .secret_versions.find(
                        (s) => s.version_id === 'sv_1'
                    );
            assert.ok(sv1);
            assert.ok(sv1.adopted_at);
        });

        test('rejects unknown version_id', async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('s0'),
            });
            await assert.rejects(
                () => registry.markSecretAdopted(
                    'i1',
                    'sv_99'
                ),
                /secret version not found/
            );
        });
    });

    describe('promoteNextSecret', () => {
        test('promotes next to current and revokes '
            + 'old', async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('s0'),
            });
            await registry.addNextSecretVersion({
                instance_id: 'i1',
                version_id: 'sv_1',
                secret_hash: sha256Hex('s1'),
            });
            await registry.markSecretAdopted(
                'i1',
                'sv_1'
            );
            const result =
                await registry.promoteNextSecret('i1');
            assert.strictEqual(
                result.new_secret_version_id,
                'sv_1'
            );
            assert.strictEqual(
                result.old_secret_version_id,
                'sv_0'
            );
            assert.strictEqual(
                result.instance.client_credentials!
                    .current_secret_version_id,
                'sv_1'
            );
            const oldSv =
                result.instance.client_credentials!
                    .secret_versions.find(
                        (s) => s.version_id === 'sv_0'
                    );
            assert.ok(oldSv!.revoked_at);
        });

        test('rejects when no next secret exists',
            async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('s0'),
            });
            await assert.rejects(
                () => registry.promoteNextSecret('i1'),
                /no next secret/
            );
        });

        test('rejects when next secret not adopted',
            async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('s0'),
            });
            await registry.addNextSecretVersion({
                instance_id: 'i1',
                version_id: 'sv_1',
                secret_hash: sha256Hex('s1'),
            });
            await assert.rejects(
                () => registry.promoteNextSecret('i1'),
                /not adopted/
            );
        });
    });

    describe('revokeSecretVersion', () => {
        test('sets revoked_at on secret version',
            async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('s0'),
            });
            await registry.addNextSecretVersion({
                instance_id: 'i1',
                version_id: 'sv_1',
                secret_hash: sha256Hex('s1'),
            });
            const inst =
                await registry.revokeSecretVersion(
                    'i1',
                    'sv_1'
                );
            const sv1 =
                inst.client_credentials!
                    .secret_versions.find(
                        (s) => s.version_id === 'sv_1'
                    );
            assert.ok(sv1!.revoked_at);
        });

        test('rejects unknown version_id', async () => {
            await registry.setInitialCredentials({
                instance_id: 'i1',
                client_id: 'cli_abc',
                version_id: 'sv_0',
                secret_hash: sha256Hex('s0'),
            });
            await assert.rejects(
                () => registry.revokeSecretVersion(
                    'i1',
                    'sv_99'
                ),
                /secret version not found/
            );
        });
    });
});
