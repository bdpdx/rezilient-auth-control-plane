import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { createFixture } from '../test-helpers';

test('Enrollment code exchange issues credentials and rejects reuse', async () => {
    const fixture = createFixture();

    await fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-acme',
        name: 'Acme',
    });

    await fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-dev-01',
        tenant_id: 'tenant-acme',
        source: 'sn://acme-dev.service-now.com',
        allowed_services: ['reg', 'rrs'],
    });

    const issued = await fixture.control_plane.services.enrollment.issueEnrollmentCode({
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        ttl_seconds: 60,
    });

    const firstExchange = await fixture.control_plane.services.enrollment.exchangeEnrollmentCode(
        issued.enrollment_code,
    );

    assert.equal(firstExchange.success, true);
    if (!firstExchange.success) {
        return;
    }

    assert.ok(firstExchange.client_id.startsWith('cli_'));
    assert.ok(firstExchange.client_secret.startsWith('sec_'));

    const secondExchange = await fixture.control_plane.services.enrollment.exchangeEnrollmentCode(
        issued.enrollment_code,
    );

    assert.equal(secondExchange.success, false);
    if (secondExchange.success) {
        return;
    }

    assert.equal(secondExchange.reason_code, 'denied_enrollment_code_used');
});

test('Enrollment code exchange fails closed for invalid and expired codes', async () => {
    const fixture = createFixture();

    await fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-acme',
        name: 'Acme',
    });

    await fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-dev-01',
        tenant_id: 'tenant-acme',
        source: 'sn://acme-dev.service-now.com',
        allowed_services: ['reg', 'rrs'],
    });

    const invalid = await fixture.control_plane.services.enrollment.exchangeEnrollmentCode(
        'enroll_invalid',
    );

    assert.equal(invalid.success, false);
    if (!invalid.success) {
        assert.equal(invalid.reason_code, 'denied_invalid_enrollment_code');
    }

    const issued = await fixture.control_plane.services.enrollment.issueEnrollmentCode({
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        ttl_seconds: 5,
    });

    fixture.clock.advanceSeconds(10);

    const expired = await fixture.control_plane.services.enrollment.exchangeEnrollmentCode(
        issued.enrollment_code,
    );

    assert.equal(expired.success, false);
    if (!expired.success) {
        assert.equal(expired.reason_code, 'denied_enrollment_code_expired');
    }
});

// ──────────────────────────────────────────────────
// Stage 6 — Extended Coverage
// ──────────────────────────────────────────────────

describe('EnrollmentService — extended coverage', () => {
    async function setupTenantAndInstance() {
        const fixture = createFixture();
        await fixture.control_plane.services.registry
            .createTenant({
                tenant_id: 'tenant-acme',
                name: 'Acme',
            });
        await fixture.control_plane.services.registry
            .createInstance({
                instance_id: 'instance-dev-01',
                tenant_id: 'tenant-acme',
                source: 'sn://acme-dev.service-now.com',
                allowed_services: ['reg', 'rrs'],
            });
        return fixture;
    }

    describe('issueEnrollmentCode', () => {
        test('code_id has enr_ prefix', async () => {
            const fixture = await setupTenantAndInstance();
            const result =
                await fixture.control_plane.services
                    .enrollment.issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });
            assert.ok(result.code_id.startsWith('enr_'));
        });

        test('enrollment_code has enroll_ prefix',
            async () => {
            const fixture = await setupTenantAndInstance();
            const result =
                await fixture.control_plane.services
                    .enrollment.issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });
            assert.ok(
                result.enrollment_code
                    .startsWith('enroll_')
            );
        });

        test('expires_at matches issued_at + '
            + 'ttl_seconds', async () => {
            const fixture = await setupTenantAndInstance();
            const result =
                await fixture.control_plane.services
                    .enrollment.issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });
            const clockNow = fixture.clock.now();
            const expected = new Date(
                clockNow.getTime() + (900 * 1000)
            ).toISOString();
            // Clock hasn't advanced, so expires_at
            // should equal now + 900s
            assert.equal(result.expires_at, expected);
        });

        test('emits enrollment_code_issued audit event',
            async () => {
            const fixture = await setupTenantAndInstance();
            await fixture.control_plane.services
                .enrollment.issueEnrollmentCode({
                    tenant_id: 'tenant-acme',
                    instance_id: 'instance-dev-01',
                    ttl_seconds: 900,
                });
            const events =
                await fixture.control_plane.services
                    .audit.list();
            const evt = events.find(
                (e) => e.event_type ===
                    'enrollment_code_issued'
            );
            assert.ok(evt);
            assert.equal(
                evt.tenant_id,
                'tenant-acme'
            );
        });
    });

    describe('exchangeEnrollmentCode — credential '
        + 'generation', () => {
        test('client_id has cli_ prefix', async () => {
            const fixture = await setupTenantAndInstance();
            const issued =
                await fixture.control_plane.services
                    .enrollment.issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });
            const result =
                await fixture.control_plane.services
                    .enrollment
                    .exchangeEnrollmentCode(
                        issued.enrollment_code
                    );
            assert.equal(result.success, true);
            if (result.success) {
                assert.ok(
                    result.client_id.startsWith('cli_')
                );
            }
        });

        test('client_secret has sec_ prefix', async () => {
            const fixture = await setupTenantAndInstance();
            const issued =
                await fixture.control_plane.services
                    .enrollment.issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });
            const result =
                await fixture.control_plane.services
                    .enrollment
                    .exchangeEnrollmentCode(
                        issued.enrollment_code
                    );
            assert.equal(result.success, true);
            if (result.success) {
                assert.ok(
                    result.client_secret
                        .startsWith('sec_')
                );
            }
        });

        test('sets initial credentials on instance via '
            + 'registry', async () => {
            const fixture = await setupTenantAndInstance();
            const issued =
                await fixture.control_plane.services
                    .enrollment.issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });
            const result =
                await fixture.control_plane.services
                    .enrollment
                    .exchangeEnrollmentCode(
                        issued.enrollment_code
                    );
            assert.equal(result.success, true);
            if (!result.success) {
                return;
            }
            const inst =
                await fixture.control_plane.services
                    .registry.getInstance(
                        'instance-dev-01'
                    );
            assert.ok(inst?.client_credentials);
            assert.equal(
                inst?.client_credentials?.client_id,
                result.client_id
            );
        });

        test('emits enrollment_code_exchanged audit '
            + 'event', async () => {
            const fixture = await setupTenantAndInstance();
            const issued =
                await fixture.control_plane.services
                    .enrollment.issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });
            await fixture.control_plane.services
                .enrollment
                .exchangeEnrollmentCode(
                    issued.enrollment_code
                );
            const events =
                await fixture.control_plane.services
                    .audit.list();
            const evt = events.find(
                (e) => e.event_type ===
                    'enrollment_code_exchanged'
            );
            assert.ok(evt);
        });
    });
});
