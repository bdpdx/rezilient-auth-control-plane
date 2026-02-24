import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
    bootstrapRegistryAndCredentials,
    createFixture,
} from '../test-helpers';

test('Dual-secret overlap supports adoption then cutover', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);

    const started = await fixture.control_plane.services.rotation.startRotation({
        instance_id: credentials.instance_id,
        overlap_seconds: 3600,
    });

    assert.ok(started.next_secret_version_id.startsWith('sv_'));
    assert.ok(started.next_client_secret.startsWith('sec_'));

    const oldMint = await fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'reg',
    });

    assert.equal(oldMint.success, true);

    const newMint = await fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: started.next_client_secret,
        service_scope: 'reg',
    });

    assert.equal(newMint.success, true);

    const completed = await fixture.control_plane.services.rotation.completeRotation({
        instance_id: credentials.instance_id,
    });

    assert.equal(completed.new_secret_version_id, started.next_secret_version_id);

    const oldAfterCutover = await fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'reg',
    });

    assert.equal(oldAfterCutover.success, false);
    if (!oldAfterCutover.success) {
        assert.equal(oldAfterCutover.reason_code, 'denied_invalid_secret');
    }

    const newAfterCutover = await fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: started.next_client_secret,
        service_scope: 'rrs',
    });

    assert.equal(newAfterCutover.success, true);

    const events = await fixture.control_plane.services.audit.list();
    const hasAdoptionEvent = events.some(
        (event) => event.event_type === 'secret_rotation_adopted',
    );

    assert.equal(hasAdoptionEvent, true);
});

test('Revoked secret version can no longer mint tokens', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);

    const instance = await fixture.control_plane.services.registry.getInstance(
        credentials.instance_id,
    );

    assert.ok(instance?.client_credentials);

    if (!instance?.client_credentials) {
        return;
    }

    await fixture.control_plane.services.rotation.revokeSecret({
        instance_id: credentials.instance_id,
        secret_version_id: instance.client_credentials.current_secret_version_id,
        reason: 'compromised',
    });

    const mint = await fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'reg',
    });

    assert.equal(mint.success, false);
    if (!mint.success) {
        assert.equal(mint.reason_code, 'denied_invalid_secret');
    }
});

// ──────────────────────────────────────────────────
// Stage 7 — Extended Coverage
// ──────────────────────────────────────────────────

describe('RotationService — extended coverage', () => {
    describe('startRotation — error paths', () => {
        test('rejects instance with no credentials',
            async () => {
            const fixture = createFixture();
            await fixture.control_plane.services
                .registry.createTenant({
                    tenant_id: 't1',
                    name: 'T',
                });
            await fixture.control_plane.services
                .registry.createInstance({
                    instance_id: 'i1',
                    tenant_id: 't1',
                    source: 'sn://dev.service-now.com',
                });
            await assert.rejects(
                () => fixture.control_plane.services
                    .rotation.startRotation({
                        instance_id: 'i1',
                        overlap_seconds: 3600,
                    }),
                /no credentials to rotate/
            );
        });

        test('rejects when rotation already in progress',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await fixture.control_plane.services
                .rotation.startRotation({
                    instance_id: creds.instance_id,
                    overlap_seconds: 3600,
                });
            await assert.rejects(
                () => fixture.control_plane.services
                    .rotation.startRotation({
                        instance_id: creds.instance_id,
                        overlap_seconds: 3600,
                    }),
                /rotation already in progress/
            );
        });

        test('next secret has sec_ prefix', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .rotation.startRotation({
                        instance_id: creds.instance_id,
                        overlap_seconds: 3600,
                    });
            assert.ok(
                result.next_client_secret
                    .startsWith('sec_')
            );
        });

        test('version ID auto-increments '
            + '(sv_0 → sv_1 → sv_2)', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const r1 =
                await fixture.control_plane.services
                    .rotation.startRotation({
                        instance_id: creds.instance_id,
                        overlap_seconds: 3600,
                    });
            assert.equal(
                r1.next_secret_version_id,
                'sv_2'
            );
            await fixture.control_plane.services
                .rotation.recordAdoption(
                    creds.instance_id,
                    r1.next_secret_version_id
                );
            await fixture.control_plane.services
                .rotation.completeRotation({
                    instance_id: creds.instance_id,
                });
            const r2 =
                await fixture.control_plane.services
                    .rotation.startRotation({
                        instance_id: creds.instance_id,
                        overlap_seconds: 3600,
                    });
            assert.equal(
                r2.next_secret_version_id,
                'sv_3'
            );
        });

        test('sets valid_until based on overlap_seconds',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .rotation.startRotation({
                        instance_id: creds.instance_id,
                        overlap_seconds: 7200,
                    });
            const nowMs = fixture.clock.now().getTime();
            const expectedExpiry = new Date(
                nowMs + (7200 * 1000)
            ).toISOString();
            assert.equal(
                result.overlap_expires_at,
                expectedExpiry
            );
        });

        test('emits secret_rotation_started audit event',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await fixture.control_plane.services
                .rotation.startRotation({
                    instance_id: creds.instance_id,
                    overlap_seconds: 3600,
                });
            const events =
                await fixture.control_plane.services
                    .audit.list();
            const evt = events.find(
                (e) => e.event_type ===
                    'secret_rotation_started'
            );
            assert.ok(evt);
        });
    });

    describe('recordAdoption', () => {
        test('sets adopted_at timestamp', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const started =
                await fixture.control_plane.services
                    .rotation.startRotation({
                        instance_id: creds.instance_id,
                        overlap_seconds: 3600,
                    });
            await fixture.control_plane.services
                .rotation.recordAdoption(
                    creds.instance_id,
                    started.next_secret_version_id
                );
            const inst =
                await fixture.control_plane.services
                    .registry.getInstance(
                        creds.instance_id
                    );
            const sv =
                inst!.client_credentials!
                    .secret_versions.find(
                        (s) => s.version_id ===
                            started.next_secret_version_id
                    );
            assert.ok(sv!.adopted_at);
        });

        test('emits secret_rotation_adopted audit event',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const started =
                await fixture.control_plane.services
                    .rotation.startRotation({
                        instance_id: creds.instance_id,
                        overlap_seconds: 3600,
                    });
            await fixture.control_plane.services
                .rotation.recordAdoption(
                    creds.instance_id,
                    started.next_secret_version_id
                );
            const events =
                await fixture.control_plane.services
                    .audit.list();
            const evt = events.find(
                (e) => e.event_type ===
                    'secret_rotation_adopted'
            );
            assert.ok(evt);
        });
    });

    describe('completeRotation — error paths', () => {
        test('rejects when no rotation in progress',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await assert.rejects(
                () => fixture.control_plane.services
                    .rotation.completeRotation({
                        instance_id: creds.instance_id,
                    }),
                /no next secret/
            );
        });

        test('rejects when next secret not yet adopted',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await fixture.control_plane.services
                .rotation.startRotation({
                    instance_id: creds.instance_id,
                    overlap_seconds: 3600,
                });
            await assert.rejects(
                () => fixture.control_plane.services
                    .rotation.completeRotation({
                        instance_id: creds.instance_id,
                    }),
                /not adopted/
            );
        });

        test('emits secret_rotation_completed audit '
            + 'event', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await fixture.control_plane.services
                .rotation.startRotation({
                    instance_id: creds.instance_id,
                    overlap_seconds: 3600,
                });
            // Use token to trigger adoption
            const inst =
                await fixture.control_plane.services
                    .registry.getInstance(
                        creds.instance_id
                    );
            const nextVerId =
                inst!.client_credentials!
                    .next_secret_version_id!;
            await fixture.control_plane.services
                .rotation.recordAdoption(
                    creds.instance_id,
                    nextVerId
                );
            await fixture.control_plane.services
                .rotation.completeRotation({
                    instance_id: creds.instance_id,
                });
            const events =
                await fixture.control_plane.services
                    .audit.list();
            const evt = events.find(
                (e) => e.event_type ===
                    'secret_rotation_completed'
            );
            assert.ok(evt);
        });
    });

    describe('revokeSecret', () => {
        test('emits secret_revoked audit event with '
            + 'reason', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const inst =
                await fixture.control_plane.services
                    .registry.getInstance(
                        creds.instance_id
                    );
            await fixture.control_plane.services
                .rotation.revokeSecret({
                    instance_id: creds.instance_id,
                    secret_version_id:
                        inst!.client_credentials!
                            .current_secret_version_id,
                    reason: 'compromised',
                });
            const events =
                await fixture.control_plane.services
                    .audit.list();
            const evt = events.find(
                (e) => e.event_type === 'secret_revoked'
            );
            assert.ok(evt);
            assert.equal(
                evt.metadata.reason,
                'compromised'
            );
        });
    });
});
