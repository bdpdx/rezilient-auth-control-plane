import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { Server } from 'node:http';
import { test } from 'node:test';
import { createControlPlaneServer } from './server';
import {
    bootstrapRegistryAndCredentials,
    createFixture,
} from './test-helpers';

interface ResponseData {
    status: number;
    body: Record<string, unknown>;
}

async function listen(server: Server): Promise<string> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('failed to bind admin control-plane test server');
    }

    return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve) => {
        server.close(() => {
            resolve();
        });
    });
}

async function getJson(
    baseUrl: string,
    path: string,
    adminToken?: string,
): Promise<ResponseData> {
    const headers: Record<string, string> = {};

    if (adminToken) {
        headers['x-rezilient-admin-token'] = adminToken;
    }

    const response = await fetch(`${baseUrl}${path}`, {
        method: 'GET',
        headers,
    });

    return {
        status: response.status,
        body: await response.json() as Record<string, unknown>,
    };
}

test('admin endpoints require token when configured', async () => {
    const fixture = createFixture();
    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
    });
    const baseUrl = await listen(server);

    try {
        const missingToken = await getJson(baseUrl, '/v1/admin/overview');
        assert.equal(missingToken.status, 403);
        assert.equal(missingToken.body.reason_code, 'admin_auth_required');

        const authorized = await getJson(
            baseUrl,
            '/v1/admin/overview',
            'admin-secret',
        );
        assert.equal(authorized.status, 200);
        assert.equal(
            authorized.body.outage_active,
            false,
        );
    } finally {
        await closeServer(server);
    }
});

test('admin instance list reports enrollment and rotation states', async () => {
    const fixture = createFixture();
    const credentials = bootstrapRegistryAndCredentials(fixture);
    const rotation = fixture.control_plane.services.rotation.startRotation({
        instance_id: credentials.instance_id,
        overlap_seconds: 600,
    });

    const adoptMint = fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: rotation.next_client_secret,
        service_scope: 'rrs',
    });

    assert.equal(adoptMint.success, true);

    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
    });
    const baseUrl = await listen(server);

    try {
        const response = await getJson(
            baseUrl,
            '/v1/admin/instances',
            'admin-secret',
        );

        assert.equal(response.status, 200);
        const instances = response.body.instances as Array<Record<string, unknown>>;
        assert.equal(instances.length, 1);
        assert.equal(instances[0].instance_id, credentials.instance_id);
        assert.equal(instances[0].enrollment_state, 'enrolled');
        assert.equal(
            instances[0].rotation_state,
            'adopted_pending_promotion',
        );

        const secretSummary = instances[0].secret_summary as Record<
            string,
            unknown
        >;
        assert.equal(secretSummary.total_versions, 2);
        assert.equal(
            typeof secretSummary.current_secret_version_id,
            'string',
        );
        assert.ok(
            String(secretSummary.current_secret_version_id).startsWith('sv_'),
        );
        assert.equal(
            typeof secretSummary.next_secret_version_id,
            'string',
        );
    } finally {
        await closeServer(server);
    }
});

test('admin overview surfaces degraded-mode and enrollment counters', async () => {
    const fixture = createFixture();
    const credentials = bootstrapRegistryAndCredentials(fixture);

    fixture.control_plane.services.token.setOutageMode(true);

    const deniedMint = fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'rrs',
    });

    assert.equal(deniedMint.success, false);

    const deniedRefresh = fixture.control_plane.services.token.mintToken({
        flow: 'refresh',
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'rrs',
    });

    assert.equal(deniedRefresh.success, false);

    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
    });
    const baseUrl = await listen(server);

    try {
        const response = await getJson(
            baseUrl,
            '/v1/admin/overview',
            'admin-secret',
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.outage_active, true);

        const degradedCounters = response.body
            .degraded_mode_counters as Record<string, unknown>;

        assert.equal(
            degradedCounters.token_mint_denied_outage_total,
            2,
        );
        assert.equal(
            degradedCounters.token_refresh_denied_outage_total,
            1,
        );

        const enrollment = response.body.enrollment as Record<string, unknown>;
        assert.equal(enrollment.codes_issued_total, 1);
        assert.equal(enrollment.codes_exchanged_total, 1);
    } finally {
        await closeServer(server);
    }
});
