import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
    createDurableControlPlane,
    ControlPlane,
} from './index';
import { FixedClock } from './utils/clock';

function createTempDbPath(name: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'acp-stage09-'));

    return join(directory, `${name}.sqlite`);
}

function createDurableFixture(dbPath: string): {
    clock: FixedClock;
    control_plane: ControlPlane;
} {
    const clock = new FixedClock('2026-02-18T09:00:00.000Z');
    const controlPlane = createDurableControlPlane(dbPath, clock, {
        issuer: 'rezilient-auth-control-plane-test',
        signing_key: 'test-signing-key-0123456789abcdef',
        token_ttl_seconds: 300,
        token_clock_skew_seconds: 30,
        outage_grace_window_seconds: 120,
    });

    return {
        clock,
        control_plane: controlPlane,
    };
}

function bootstrapTenantAndInstance(fixture: {
    control_plane: ControlPlane;
}): void {
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
}

test('durable ACP state survives restart for registry/enrollment/audit', () => {
    const dbPath = createTempDbPath('restart-survival');
    const first = createDurableFixture(dbPath);

    bootstrapTenantAndInstance(first);

    const issued = first.control_plane.services.enrollment.issueEnrollmentCode({
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        ttl_seconds: 900,
    });

    const exchanged = first.control_plane.services.enrollment.exchangeEnrollmentCode(
        issued.enrollment_code,
    );

    assert.equal(exchanged.success, true);
    if (!exchanged.success) {
        return;
    }

    const minted = first.control_plane.services.token.mintToken({
        client_id: exchanged.client_id,
        client_secret: exchanged.client_secret,
        service_scope: 'reg',
    });

    assert.equal(minted.success, true);

    const restarted = createDurableFixture(dbPath);
    const tenants = restarted.control_plane.services.registry.listTenants();
    const instances = restarted.control_plane.services.registry.listInstances();

    assert.equal(tenants.length, 1);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].instance_id, 'instance-dev-01');
    assert.equal(
        instances[0].client_credentials?.client_id,
        exchanged.client_id,
    );

    const mintAfterRestart = restarted.control_plane.services.token.mintToken({
        client_id: exchanged.client_id,
        client_secret: exchanged.client_secret,
        service_scope: 'rrs',
    });

    assert.equal(mintAfterRestart.success, true);

    const events = restarted.control_plane.services.audit.list();
    const hasExchangeEvent = events.some(
        (event) => event.event_type === 'enrollment_code_exchanged',
    );
    const hasMintEvent = events.some(
        (event) => event.event_type === 'token_minted',
    );

    assert.equal(hasExchangeEvent, true);
    assert.equal(hasMintEvent, true);
});

test('enrollment exchange concurrency allows only one successful exchange', async () => {
    const dbPath = createTempDbPath('enrollment-concurrency');
    const fixtureA = createDurableFixture(dbPath);
    const fixtureB = createDurableFixture(dbPath);

    bootstrapTenantAndInstance(fixtureA);

    const issued = fixtureA.control_plane.services.enrollment.issueEnrollmentCode({
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        ttl_seconds: 900,
    });

    const [firstResult, secondResult] = await Promise.all([
        Promise.resolve().then(() =>
            fixtureA.control_plane.services.enrollment.exchangeEnrollmentCode(
                issued.enrollment_code,
            )
        ),
        Promise.resolve().then(() =>
            fixtureB.control_plane.services.enrollment.exchangeEnrollmentCode(
                issued.enrollment_code,
            )
        ),
    ]);

    const successCount = [firstResult, secondResult].filter((result) =>
        result.success
    ).length;
    const failure = [firstResult, secondResult].find((result) => !result.success);

    assert.equal(successCount, 1);
    assert.ok(failure);

    if (failure && !failure.success) {
        assert.equal(failure.reason_code, 'denied_enrollment_code_used');
    }
});

test('rotation update concurrency prevents double-start and keeps state valid', async () => {
    const dbPath = createTempDbPath('rotation-concurrency');
    const fixtureA = createDurableFixture(dbPath);
    const fixtureB = createDurableFixture(dbPath);

    bootstrapTenantAndInstance(fixtureA);

    const issued = fixtureA.control_plane.services.enrollment.issueEnrollmentCode({
        tenant_id: 'tenant-acme',
        instance_id: 'instance-dev-01',
        ttl_seconds: 900,
    });

    const exchanged = fixtureA.control_plane.services.enrollment.exchangeEnrollmentCode(
        issued.enrollment_code,
    );

    assert.equal(exchanged.success, true);
    if (!exchanged.success) {
        return;
    }

    const [startA, startB] = await Promise.all([
        Promise.resolve().then(() => {
            try {
                return {
                    success: true,
                    value: fixtureA.control_plane.services.rotation.startRotation({
                        instance_id: 'instance-dev-01',
                        overlap_seconds: 600,
                    }),
                };
            } catch (error) {
                return {
                    success: false,
                    message: String(error),
                };
            }
        }),
        Promise.resolve().then(() => {
            try {
                return {
                    success: true,
                    value: fixtureB.control_plane.services.rotation.startRotation({
                        instance_id: 'instance-dev-01',
                        overlap_seconds: 600,
                    }),
                };
            } catch (error) {
                return {
                    success: false,
                    message: String(error),
                };
            }
        }),
    ]);

    const successStart = [startA, startB].find((entry) => entry.success);
    const failedStart = [startA, startB].find((entry) => !entry.success);

    assert.ok(successStart);
    assert.ok(failedStart);

    if (!successStart || !successStart.success) {
        return;
    }

    if (!successStart.value) {
        return;
    }

    if (failedStart && !failedStart.success) {
        const failureMessage = failedStart.message ?? '';

        assert.match(failureMessage, /rotation already in progress/);
    }

    const adoptionMint = fixtureA.control_plane.services.token.mintToken({
        client_id: exchanged.client_id,
        client_secret: successStart.value.next_client_secret,
        service_scope: 'reg',
    });

    assert.equal(adoptionMint.success, true);

    const completed = fixtureB.control_plane.services.rotation.completeRotation({
        instance_id: 'instance-dev-01',
    });

    assert.ok(completed.new_secret_version_id.startsWith('sv_'));
});
