import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
    createFixture,
    bootstrapRegistryAndCredentials,
} from './test-helpers';
import { FixedClock } from './utils/clock';

describe('createFixture', () => {
    test('returns fixture with FixedClock at default '
        + 'time', () => {
        const fixture = createFixture();
        assert.ok(fixture.clock instanceof FixedClock);
        assert.equal(
            fixture.clock.now().toISOString(),
            '2026-02-16T12:00:00.000Z'
        );
    });

    test('returns control plane with all services',
        () => {
        const fixture = createFixture();
        const svc = fixture.control_plane.services;
        assert.ok(svc.registry);
        assert.ok(svc.enrollment);
        assert.ok(svc.rotation);
        assert.ok(svc.token);
        assert.ok(svc.audit);
    });
});

describe('bootstrapRegistryAndCredentials', () => {
    test('creates tenant, instance, and exchanges '
        + 'enrollment code', async () => {
        const fixture = createFixture();
        const creds =
            await bootstrapRegistryAndCredentials(
                fixture
            );
        assert.ok(creds.tenant_id);
        assert.ok(creds.instance_id);
        assert.ok(creds.client_id);
        assert.ok(creds.client_secret);

        const tenant =
            await fixture.control_plane.services
                .registry.getTenant(creds.tenant_id);
        assert.ok(tenant);

        const instance =
            await fixture.control_plane.services
                .registry.getInstance(
                    creds.instance_id
                );
        assert.ok(instance);
    });

    test('returned credentials have expected '
        + 'prefixes', async () => {
        const fixture = createFixture();
        const creds =
            await bootstrapRegistryAndCredentials(
                fixture
            );
        assert.ok(
            creds.client_id.startsWith('cli_'),
            'client_id should start with cli_'
        );
        assert.ok(
            creds.client_secret.startsWith('sec_'),
            'client_secret should start with sec_'
        );
    });

    test('respects custom options when provided',
        async () => {
        const fixture = createFixture();
        const creds =
            await bootstrapRegistryAndCredentials(
                fixture,
                {
                    tenant_id: 'custom-tenant',
                    tenant_name: 'Custom Corp',
                    instance_id: 'custom-instance',
                    source: 'sn://custom.service-now.com',
                    allowed_services: ['reg'],
                }
            );
        assert.equal(creds.tenant_id, 'custom-tenant');
        assert.equal(
            creds.instance_id,
            'custom-instance'
        );

        const instance =
            await fixture.control_plane.services
                .registry.getInstance(
                    'custom-instance'
                );
        assert.ok(instance);
        assert.deepEqual(
            instance.allowed_services,
            ['reg']
        );
    });
});
