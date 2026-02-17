import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
    bootstrapRegistryAndCredentials,
    createFixture,
} from './test-helpers';

test('Outage grace decision pauses only after grace window is exhausted', () => {
    const fixture = createFixture();
    const credentials = bootstrapRegistryAndCredentials(fixture);

    const mint = fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'reg',
    });

    assert.equal(mint.success, true);

    if (!mint.success) {
        return;
    }

    fixture.control_plane.services.token.setOutageMode(true);

    fixture.clock.advanceSeconds(310);

    const withinGrace = fixture.control_plane.services.token
        .evaluateRefreshDuringOutage(mint.expires_at);

    assert.equal(withinGrace.action, 'retry_within_grace');
    assert.equal(withinGrace.reason_code, 'blocked_auth_control_plane_outage');

    fixture.clock.advanceSeconds(121);

    const exhaustedGrace = fixture.control_plane.services.token
        .evaluateRefreshDuringOutage(mint.expires_at);

    assert.equal(exhaustedGrace.action, 'pause_in_flight');
    assert.equal(
        exhaustedGrace.reason_code,
        'paused_token_refresh_grace_exhausted',
    );
});

test('Entitlement/instance disable behavior pauses at next chunk boundary', () => {
    const fixture = createFixture();
    const credentials = bootstrapRegistryAndCredentials(fixture);

    const continueActive = fixture.control_plane.services.token
        .evaluateInFlightEntitlement(credentials.instance_id, false);

    assert.equal(continueActive.action, 'continue');

    fixture.control_plane.services.registry.setTenantEntitlement(
        credentials.tenant_id,
        'disabled',
    );

    const beforeBoundary = fixture.control_plane.services.token
        .evaluateInFlightEntitlement(credentials.instance_id, false);

    assert.equal(beforeBoundary.action, 'continue_until_chunk_boundary');
    assert.equal(beforeBoundary.reason_code, 'paused_entitlement_disabled');

    const atBoundary = fixture.control_plane.services.token
        .evaluateInFlightEntitlement(credentials.instance_id, true);

    assert.equal(atBoundary.action, 'pause');
    assert.equal(atBoundary.reason_code, 'paused_entitlement_disabled');

    fixture.control_plane.services.registry.setTenantEntitlement(
        credentials.tenant_id,
        'active',
    );
    fixture.control_plane.services.registry.setInstanceState(
        credentials.instance_id,
        'disabled',
    );

    const instanceAtBoundary = fixture.control_plane.services.token
        .evaluateInFlightEntitlement(credentials.instance_id, true);

    assert.equal(instanceAtBoundary.action, 'pause');
    assert.equal(instanceAtBoundary.reason_code, 'paused_instance_disabled');
});
