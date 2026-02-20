import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
    bootstrapRegistryAndCredentials,
    createFixture,
} from './test-helpers';

test('Outage grace decision pauses only after grace window is exhausted', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);

    const mint = await fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'reg',
    });

    assert.equal(mint.success, true);

    if (!mint.success) {
        return;
    }

    await fixture.control_plane.services.token.setOutageMode(true);

    fixture.clock.advanceSeconds(310);

    const withinGrace = fixture.control_plane.services.token
        .evaluateRefreshDuringOutage(mint.expires_at);
    const withinGraceResult = await withinGrace;

    assert.equal(withinGraceResult.action, 'retry_within_grace');
    assert.equal(
        withinGraceResult.reason_code,
        'blocked_auth_control_plane_outage',
    );

    fixture.clock.advanceSeconds(121);

    const exhaustedGrace = fixture.control_plane.services.token
        .evaluateRefreshDuringOutage(mint.expires_at);
    const exhaustedGraceResult = await exhaustedGrace;

    assert.equal(exhaustedGraceResult.action, 'pause_in_flight');
    assert.equal(
        exhaustedGraceResult.reason_code,
        'paused_token_refresh_grace_exhausted',
    );
});

test('Entitlement/instance disable behavior pauses at next chunk boundary', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);

    const continueActive = fixture.control_plane.services.token
        .evaluateInFlightEntitlement(credentials.instance_id, false);
    const continueActiveResult = await continueActive;

    assert.equal(continueActiveResult.action, 'continue');

    await fixture.control_plane.services.registry.setTenantEntitlement(
        credentials.tenant_id,
        'disabled',
    );

    const beforeBoundary = fixture.control_plane.services.token
        .evaluateInFlightEntitlement(credentials.instance_id, false);
    const beforeBoundaryResult = await beforeBoundary;

    assert.equal(beforeBoundaryResult.action, 'continue_until_chunk_boundary');
    assert.equal(
        beforeBoundaryResult.reason_code,
        'paused_entitlement_disabled',
    );

    const atBoundary = fixture.control_plane.services.token
        .evaluateInFlightEntitlement(credentials.instance_id, true);
    const atBoundaryResult = await atBoundary;

    assert.equal(atBoundaryResult.action, 'pause');
    assert.equal(atBoundaryResult.reason_code, 'paused_entitlement_disabled');

    await fixture.control_plane.services.registry.setTenantEntitlement(
        credentials.tenant_id,
        'active',
    );
    await fixture.control_plane.services.registry.setInstanceState(
        credentials.instance_id,
        'disabled',
    );

    const instanceAtBoundary = fixture.control_plane.services.token
        .evaluateInFlightEntitlement(credentials.instance_id, true);
    const instanceAtBoundaryResult = await instanceAtBoundary;

    assert.equal(instanceAtBoundaryResult.action, 'pause');
    assert.equal(
        instanceAtBoundaryResult.reason_code,
        'paused_instance_disabled',
    );
});
