import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createFixture } from '../test-helpers';

test('Enrollment code exchange issues credentials and rejects reuse', () => {
    const fixture = createFixture();

    fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-acme',
        name: 'Acme',
    });

    fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-dev-01',
        tenant_id: 'tenant-acme',
        source: 'sn://acme-dev.service-now.com',
        allowed_services: ['reg', 'rrs'],
    });

    const issued = fixture.control_plane.services.enrollment.issueEnrollmentCode({
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        ttl_seconds: 60,
    });

    const firstExchange = fixture.control_plane.services.enrollment.exchangeEnrollmentCode(
        issued.enrollment_code,
    );

    assert.equal(firstExchange.success, true);
    if (!firstExchange.success) {
        return;
    }

    assert.ok(firstExchange.client_id.startsWith('cli_'));
    assert.ok(firstExchange.client_secret.startsWith('sec_'));

    const secondExchange = fixture.control_plane.services.enrollment.exchangeEnrollmentCode(
        issued.enrollment_code,
    );

    assert.equal(secondExchange.success, false);
    if (secondExchange.success) {
        return;
    }

    assert.equal(secondExchange.reason_code, 'denied_enrollment_code_used');
});

test('Enrollment code exchange fails closed for invalid and expired codes', () => {
    const fixture = createFixture();

    fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-acme',
        name: 'Acme',
    });

    fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-dev-01',
        tenant_id: 'tenant-acme',
        source: 'sn://acme-dev.service-now.com',
        allowed_services: ['reg', 'rrs'],
    });

    const invalid = fixture.control_plane.services.enrollment.exchangeEnrollmentCode(
        'enroll_invalid',
    );

    assert.equal(invalid.success, false);
    if (!invalid.success) {
        assert.equal(invalid.reason_code, 'denied_invalid_enrollment_code');
    }

    const issued = fixture.control_plane.services.enrollment.issueEnrollmentCode({
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        ttl_seconds: 5,
    });

    fixture.clock.advanceSeconds(10);

    const expired = fixture.control_plane.services.enrollment.exchangeEnrollmentCode(
        issued.enrollment_code,
    );

    assert.equal(expired.success, false);
    if (!expired.success) {
        assert.equal(expired.reason_code, 'denied_enrollment_code_expired');
    }
});
