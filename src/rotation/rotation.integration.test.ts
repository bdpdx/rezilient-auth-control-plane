import { strict as assert } from 'node:assert';
import { test } from 'node:test';
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
