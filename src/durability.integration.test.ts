import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
    createDurableControlPlane,
    ControlPlane,
} from './index';
import { FixedClock } from './utils/clock';

const TEST_PG_URL = process.env.ACP_TEST_PG_URL;
const SKIP_DURABILITY_TESTS = TEST_PG_URL === undefined;

function createSnapshotKey(name: string): string {
    return `test_${name}_${randomUUID().replace(/-/g, '_')}`;
}

async function createDurableFixture(snapshotKey: string): Promise<{
    clock: FixedClock;
    control_plane: ControlPlane;
}> {
    if (!TEST_PG_URL) {
        throw new Error('ACP_TEST_PG_URL is required');
    }

    const clock = new FixedClock('2026-02-18T09:00:00.000Z');
    const controlPlane = await createDurableControlPlane(
        TEST_PG_URL,
        clock,
        {
            issuer: 'rezilient-auth-control-plane-test',
            signing_key: 'test-signing-key-0123456789abcdef',
            token_ttl_seconds: 300,
            token_clock_skew_seconds: 30,
            outage_grace_window_seconds: 120,
        },
        {
            snapshot_key: snapshotKey,
        },
    );

    return {
        clock,
        control_plane: controlPlane,
    };
}

async function bootstrapTenantAndInstance(fixture: {
    control_plane: ControlPlane;
}): Promise<void> {
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
}

test(
    'durable ACP state survives restart for registry/enrollment/audit',
    { skip: SKIP_DURABILITY_TESTS },
    async () => {
        const snapshotKey = createSnapshotKey('restart_survival');
        const first = await createDurableFixture(snapshotKey);
        let persistedClientId = '';
        let persistedClientSecret = '';

        try {
            await bootstrapTenantAndInstance(first);

            const issued =
                await first.control_plane.services.enrollment
                    .issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });

            const exchanged =
                await first.control_plane.services.enrollment
                    .exchangeEnrollmentCode(
                        issued.enrollment_code,
                    );

            assert.equal(exchanged.success, true);
            if (!exchanged.success) {
                return;
            }
            persistedClientId = exchanged.client_id;
            persistedClientSecret = exchanged.client_secret;

            const minted = await first.control_plane.services.token.mintToken({
                client_id: persistedClientId,
                client_secret: persistedClientSecret,
                service_scope: 'reg',
            });

            assert.equal(minted.success, true);
        } finally {
            await first.control_plane.close();
        }

        const restarted = await createDurableFixture(snapshotKey);

        try {
            const tenants =
                await restarted.control_plane.services.registry.listTenants();
            const instances =
                await restarted.control_plane.services.registry.listInstances();

            assert.equal(tenants.length, 1);
            assert.equal(instances.length, 1);
            assert.equal(instances[0].instance_id, 'instance-dev-01');
            const clientId = instances[0].client_credentials?.client_id;

            assert.ok(clientId);
            assert.equal(clientId, persistedClientId);

            if (!clientId) {
                return;
            }

            const mintAfterRestart =
                await restarted.control_plane.services.token.mintToken({
                    client_id: clientId,
                    client_secret: persistedClientSecret,
                    service_scope: 'rrs',
                });

            assert.equal(mintAfterRestart.success, true);

            const events = await restarted.control_plane.services.audit.list();
            const hasExchangeEvent = events.some(
                (event) => event.event_type === 'enrollment_code_exchanged',
            );
            const hasMintEvent = events.some(
                (event) => event.event_type === 'token_minted',
            );

            assert.equal(hasExchangeEvent, true);
            assert.equal(hasMintEvent, true);
        } finally {
            await restarted.control_plane.close();
        }
    },
);

test(
    'enrollment exchange concurrency allows only one successful exchange',
    { skip: SKIP_DURABILITY_TESTS },
    async () => {
        const snapshotKey = createSnapshotKey('enrollment_concurrency');
        const fixtureA = await createDurableFixture(snapshotKey);
        const fixtureB = await createDurableFixture(snapshotKey);

        try {
            await bootstrapTenantAndInstance(fixtureA);

            const issued =
                await fixtureA.control_plane.services.enrollment
                    .issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });

            const [firstResult, secondResult] = await Promise.all([
                fixtureA.control_plane.services.enrollment.exchangeEnrollmentCode(
                    issued.enrollment_code,
                ),
                fixtureB.control_plane.services.enrollment.exchangeEnrollmentCode(
                    issued.enrollment_code,
                ),
            ]);

            const successCount = [firstResult, secondResult].filter((result) =>
                result.success
            ).length;
            const failure = [firstResult, secondResult].find((result) =>
                !result.success
            );

            assert.equal(successCount, 1);
            assert.ok(failure);

            if (failure && !failure.success) {
                assert.equal(failure.reason_code, 'denied_enrollment_code_used');
            }
        } finally {
            await fixtureA.control_plane.close();
            await fixtureB.control_plane.close();
        }
    },
);

test(
    'rotation update concurrency prevents double-start and keeps state valid',
    { skip: SKIP_DURABILITY_TESTS },
    async () => {
        const snapshotKey = createSnapshotKey('rotation_concurrency');
        const fixtureA = await createDurableFixture(snapshotKey);
        const fixtureB = await createDurableFixture(snapshotKey);

        try {
            await bootstrapTenantAndInstance(fixtureA);

            const issued =
                await fixtureA.control_plane.services.enrollment
                    .issueEnrollmentCode({
                        tenant_id: 'tenant-acme',
                        instance_id: 'instance-dev-01',
                        ttl_seconds: 900,
                    });

            const exchanged =
                await fixtureA.control_plane.services.enrollment
                    .exchangeEnrollmentCode(
                        issued.enrollment_code,
                    );

            assert.equal(exchanged.success, true);
            if (!exchanged.success) {
                return;
            }

            const [startA, startB] = await Promise.all([
                (async () => {
                    try {
                        return {
                            success: true,
                            value:
                                await fixtureA.control_plane.services.rotation
                                    .startRotation({
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
                })(),
                (async () => {
                    try {
                        return {
                            success: true,
                            value:
                                await fixtureB.control_plane.services.rotation
                                    .startRotation({
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
                })(),
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

            const adoptionMint =
                await fixtureA.control_plane.services.token.mintToken({
                    client_id: exchanged.client_id,
                    client_secret: successStart.value.next_client_secret,
                    service_scope: 'reg',
                });

            assert.equal(adoptionMint.success, true);

            const completed =
                await fixtureB.control_plane.services.rotation.completeRotation({
                    instance_id: 'instance-dev-01',
                });

            assert.ok(completed.new_secret_version_id.startsWith('sv_'));
        } finally {
            await fixtureA.control_plane.close();
            await fixtureB.control_plane.close();
        }
    },
);
