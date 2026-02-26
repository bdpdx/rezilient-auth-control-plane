import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { Server } from 'node:http';
import { describe, test } from 'node:test';
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

async function postRaw(
    baseUrl: string,
    path: string,
    body: string,
    headers?: Record<string, string>,
): Promise<ResponseData> {
    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body,
    });

    return {
        status: response.status,
        body: await response.json() as Record<string, unknown>,
    };
}

async function postJson(
    baseUrl: string,
    path: string,
    body: Record<string, unknown>,
    adminToken?: string,
): Promise<ResponseData> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    };

    if (adminToken) {
        headers['x-rezilient-admin-token'] = adminToken;
    }

    return postRaw(baseUrl, path, JSON.stringify(body), headers);
}

async function postInternalJson(
    baseUrl: string,
    path: string,
    body: Record<string, unknown>,
    internalToken?: string,
): Promise<ResponseData> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    };

    if (internalToken) {
        headers['x-rezilient-internal-token'] = internalToken;
    }

    return postRaw(baseUrl, path, JSON.stringify(body), headers);
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

        const wrongToken = await getJson(
            baseUrl,
            '/v1/admin/overview',
            'wrong-secret',
        );
        assert.equal(wrongToken.status, 403);
        assert.equal(wrongToken.body.reason_code, 'admin_auth_required');

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

test('internal endpoints require token when configured', async () => {
    const fixture = createFixture();
    await fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-acme',
        name: 'Acme',
    });
    await fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-acme-01',
        tenant_id: 'tenant-acme',
        source: 'sn://acme-dev.service-now.com',
    });
    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
        internalToken: 'internal-secret',
    });
    const baseUrl = await listen(server);

    try {
        const missingToken = await postInternalJson(
            baseUrl,
            '/v1/internal/source-mapping/resolve',
            {
                tenant_id: 'tenant-acme',
                instance_id: 'instance-acme-01',
            },
        );
        assert.equal(missingToken.status, 403);
        assert.equal(
            missingToken.body.reason_code,
            'internal_auth_required',
        );

        const wrongToken = await postInternalJson(
            baseUrl,
            '/v1/internal/source-mapping/resolve',
            {
                tenant_id: 'tenant-acme',
                instance_id: 'instance-acme-01',
            },
            'wrong-secret',
        );
        assert.equal(wrongToken.status, 403);
        assert.equal(
            wrongToken.body.reason_code,
            'internal_auth_required',
        );

        const authorized = await postInternalJson(
            baseUrl,
            '/v1/internal/source-mapping/resolve',
            {
                tenant_id: 'tenant-acme',
                instance_id: 'instance-acme-01',
            },
            'internal-secret',
        );
        assert.equal(authorized.status, 200);
        assert.equal(authorized.body.ok, true);
        assert.equal(authorized.body.tenant_id, 'tenant-acme');
        assert.equal(authorized.body.instance_id, 'instance-acme-01');
        assert.equal(authorized.body.requested_service_scope, 'rrs');
        assert.equal(authorized.body.service_allowed, true);
    } finally {
        await closeServer(server);
    }
});

test('internal resolve returns not_found when mapping is missing', async () => {
    const fixture = createFixture();
    const server = createControlPlaneServer(fixture.control_plane.services, {
        internalToken: 'internal-secret',
    });
    const baseUrl = await listen(server);

    try {
        const response = await postInternalJson(
            baseUrl,
            '/v1/internal/source-mapping/resolve',
            {
                tenant_id: 'tenant-missing',
                instance_id: 'instance-missing',
            },
            'internal-secret',
        );

        assert.equal(response.status, 404);
        assert.equal(response.body.error, 'not_found');
        assert.equal(
            response.body.reason_code,
            'tenant_instance_mapping_not_found',
        );
    } finally {
        await closeServer(server);
    }
});

test('internal resolve reports service not allowed for requested scope', async () => {
    const fixture = createFixture();
    await fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-reg-only',
        name: 'Tenant Reg Only',
    });
    await fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-reg-only',
        tenant_id: 'tenant-reg-only',
        source: 'sn://reg-only.service-now.com',
        allowed_services: ['reg'],
    });
    const server = createControlPlaneServer(fixture.control_plane.services, {
        internalToken: 'internal-secret',
    });
    const baseUrl = await listen(server);

    try {
        const response = await postInternalJson(
            baseUrl,
            '/v1/internal/source-mapping/resolve',
            {
                tenant_id: 'tenant-reg-only',
                instance_id: 'instance-reg-only',
                service_scope: 'rrs',
            },
            'internal-secret',
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.service_allowed, false);
        assert.deepEqual(response.body.allowed_services, ['reg']);
    } finally {
        await closeServer(server);
    }
});

test('internal resolve includes inactive tenant and instance states', async () => {
    const fixture = createFixture();
    await fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-suspended',
        name: 'Tenant Suspended',
        state: 'suspended',
        entitlement_state: 'disabled',
    });
    await fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-suspended',
        tenant_id: 'tenant-suspended',
        source: 'sn://suspended.service-now.com',
        state: 'suspended',
    });
    const server = createControlPlaneServer(fixture.control_plane.services, {
        internalToken: 'internal-secret',
    });
    const baseUrl = await listen(server);

    try {
        const response = await postInternalJson(
            baseUrl,
            '/v1/internal/source-mapping/resolve',
            {
                tenant_id: 'tenant-suspended',
                instance_id: 'instance-suspended',
                service_scope: 'rrs',
            },
            'internal-secret',
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.tenant_state, 'suspended');
        assert.equal(response.body.entitlement_state, 'disabled');
        assert.equal(response.body.instance_state, 'suspended');
        assert.equal(response.body.service_allowed, true);
    } finally {
        await closeServer(server);
    }
});

test('internal list returns canonical mappings and applies filters', async () => {
    const fixture = createFixture();
    await fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-active',
        name: 'Tenant Active',
    });
    await fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-active',
        tenant_id: 'tenant-active',
        source: 'sn://active.service-now.com',
    });
    await fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-inactive',
        name: 'Tenant Inactive',
        state: 'suspended',
    });
    await fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-inactive',
        tenant_id: 'tenant-inactive',
        source: 'sn://inactive.service-now.com',
        state: 'suspended',
    });
    await fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-reg-only',
        name: 'Tenant Reg Only',
    });
    await fixture.control_plane.services.registry.createInstance({
        instance_id: 'instance-reg-only',
        tenant_id: 'tenant-reg-only',
        source: 'sn://reg-only-list.service-now.com',
        allowed_services: ['reg'],
    });
    const server = createControlPlaneServer(fixture.control_plane.services, {
        internalToken: 'internal-secret',
    });
    const baseUrl = await listen(server);

    try {
        const allMappings = await postInternalJson(
            baseUrl,
            '/v1/internal/source-mappings/list',
            {},
            'internal-secret',
        );
        assert.equal(allMappings.status, 200);
        assert.equal(allMappings.body.ok, true);
        const allRecords = allMappings.body.source_mappings as Array<
            Record<string, unknown>
        >;
        assert.equal(allRecords.length, 3);

        const filtered = await postInternalJson(
            baseUrl,
            '/v1/internal/source-mappings/list',
            {
                service_scope: 'rrs',
                instance_state: 'active',
            },
            'internal-secret',
        );
        assert.equal(filtered.status, 200);
        const filteredRecords = filtered.body.source_mappings as Array<
            Record<string, unknown>
        >;
        assert.equal(filteredRecords.length, 1);
        assert.equal(filteredRecords[0].instance_id, 'instance-active');

        const inactiveOnly = await postInternalJson(
            baseUrl,
            '/v1/internal/source-mappings/list',
            {
                tenant_state: 'suspended',
            },
            'internal-secret',
        );
        assert.equal(inactiveOnly.status, 200);
        const inactiveRecords = inactiveOnly.body.source_mappings as Array<
            Record<string, unknown>
        >;
        assert.equal(inactiveRecords.length, 1);
        assert.equal(inactiveRecords[0].instance_id, 'instance-inactive');
        assert.equal(inactiveRecords[0].tenant_state, 'suspended');
    } finally {
        await closeServer(server);
    }
});

test('oversized JSON requests return 413 payload too large', async () => {
    const fixture = createFixture();
    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
        maxJsonBodyBytes: 128,
    });
    const baseUrl = await listen(server);
    const oversizedPayload = JSON.stringify({
        client_id: 'cid',
        client_secret: 'x'.repeat(256),
        service_scope: 'reg',
    });

    try {
        const response = await postRaw(
            baseUrl,
            '/v1/auth/token',
            oversizedPayload,
            {
                'content-type': 'application/json',
            },
        );

        assert.equal(response.status, 413);
        assert.equal(response.body.error, 'payload_too_large');
        assert.equal(
            response.body.reason_code,
            'request_body_too_large',
        );
        assert.equal(response.body.max_bytes, 128);
    } finally {
        await closeServer(server);
    }
});

test('JSON array request body returns 400 with descriptive error', async () => {
    const fixture = createFixture();
    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
    });
    const baseUrl = await listen(server);

    try {
        const response = await postRaw(
            baseUrl,
            '/v1/auth/token',
            '[1,2,3]',
            {
                'content-type': 'application/json',
            },
        );

        assert.equal(response.status, 400);
        assert.equal(
            response.body.message,
            'request body must be an object, not an array',
        );
    } finally {
        await closeServer(server);
    }
});

test('admin instance list reports enrollment and rotation states', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);
    const rotation = await fixture.control_plane.services.rotation.startRotation({
        instance_id: credentials.instance_id,
        overlap_seconds: 600,
    });

    const adoptMint = await fixture.control_plane.services.token.mintToken({
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

        const creds = instances[0].client_credentials as Record<
            string,
            unknown
        >;
        assert.ok(creds);
        const versions = creds.secret_versions as Array<
            Record<string, unknown>
        >;

        for (const version of versions) {
            assert.equal(
                'secret_hash' in version,
                false,
                'secret_hash must not appear in admin instance response',
            );
        }
    } finally {
        await closeServer(server);
    }
});

test('admin overview surfaces degraded-mode and enrollment counters', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);

    await fixture.control_plane.services.token.setOutageMode(true);

    const deniedMint = await fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'rrs',
    });

    assert.equal(deniedMint.success, false);

    const deniedRefresh = await fixture.control_plane.services.token.mintToken({
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

test('admin lifecycle endpoints return not_found/conflict reason codes', async () => {
    const fixture = createFixture();
    await fixture.control_plane.services.registry.createTenant({
        tenant_id: 'tenant-acme',
        name: 'Acme',
    });

    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
    });
    const baseUrl = await listen(server);

    try {
        const missingInstanceState = await postJson(
            baseUrl,
            '/v1/admin/instances/instance-missing/state',
            {
                state: 'disabled',
            },
            'admin-secret',
        );

        assert.equal(missingInstanceState.status, 404);
        assert.equal(missingInstanceState.body.error, 'not_found');
        assert.equal(
            missingInstanceState.body.reason_code,
            'instance_not_found',
        );

        const duplicateTenant = await postJson(
            baseUrl,
            '/v1/admin/tenants',
            {
                tenant_id: 'tenant-acme',
                name: 'Acme duplicate',
            },
            'admin-secret',
        );

        assert.equal(duplicateTenant.status, 409);
        assert.equal(duplicateTenant.body.error, 'conflict');
        assert.equal(
            duplicateTenant.body.reason_code,
            'tenant_already_exists',
        );
    } finally {
        await closeServer(server);
    }
});

test('admin lifecycle endpoints enforce strict validation', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);

    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
    });
    const baseUrl = await listen(server);

    try {
        const invalidLimit = await getJson(
            baseUrl,
            '/v1/admin/audit-events?limit=0',
            'admin-secret',
        );

        assert.equal(invalidLimit.status, 400);
        assert.equal(invalidLimit.body.reason_code, 'invalid_admin_request');
        assert.equal(
            invalidLimit.body.message,
            'limit must be a positive integer',
        );
        const invalidCrossServiceLimit = await getJson(
            baseUrl,
            '/v1/admin/audit-events/cross-service?limit=0',
            'admin-secret',
        );

        assert.equal(invalidCrossServiceLimit.status, 400);
        assert.equal(
            invalidCrossServiceLimit.body.reason_code,
            'invalid_admin_request',
        );
        assert.equal(
            invalidCrossServiceLimit.body.message,
            'limit must be a positive integer',
        );

        const invalidTtl = await postJson(
            baseUrl,
            '/v1/admin/enrollment-codes',
            {
                tenant_id: credentials.tenant_id,
                instance_id: credentials.instance_id,
                ttl_seconds: 0,
            },
            'admin-secret',
        );

        assert.equal(invalidTtl.status, 400);
        assert.equal(invalidTtl.body.reason_code, 'invalid_admin_request');
        assert.equal(
            invalidTtl.body.message,
            'ttl_seconds must be a positive integer',
        );

        const invalidOverlap = await postJson(
            baseUrl,
            `/v1/admin/instances/${credentials.instance_id}/rotate-secret`,
            {
                overlap_seconds: 0,
            },
            'admin-secret',
        );

        assert.equal(invalidOverlap.status, 400);
        assert.equal(invalidOverlap.body.reason_code, 'invalid_admin_request');
        assert.equal(
            invalidOverlap.body.message,
            'overlap_seconds must be a positive integer',
        );

        const invalidOutageToggle = await postJson(
            baseUrl,
            '/v1/admin/degraded-mode',
            {
                outage_active: 'true',
            },
            'admin-secret',
        );

        assert.equal(invalidOutageToggle.status, 400);
        assert.equal(
            invalidOutageToggle.body.reason_code,
            'invalid_admin_request',
        );
        assert.equal(
            invalidOutageToggle.body.message,
            'outage_active must be a boolean',
        );
    } finally {
        await closeServer(server);
    }
});

test('token mint rejects invalid flow values', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);
    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
    });
    const baseUrl = await listen(server);

    try {
        const invalidFlow = await postJson(
            baseUrl,
            '/v1/auth/token',
            {
                client_id: credentials.client_id,
                client_secret: credentials.client_secret,
                service_scope: 'reg',
                flow: 'invalid',
            },
        );

        assert.equal(invalidFlow.status, 400);
        assert.equal(invalidFlow.body.reason_code, 'invalid_admin_request');
        assert.equal(
            invalidFlow.body.message,
            'flow must be "mint" or "refresh" when provided',
        );

        const numericFlow = await postJson(
            baseUrl,
            '/v1/auth/token',
            {
                client_id: credentials.client_id,
                client_secret: credentials.client_secret,
                service_scope: 'reg',
                flow: 42,
            },
        );

        assert.equal(numericFlow.status, 400);
        assert.equal(numericFlow.body.reason_code, 'invalid_admin_request');
    } finally {
        await closeServer(server);
    }
});

test('admin cross-service audit endpoint returns normalized events', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);

    const minted = await fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'reg',
    });

    assert.equal(minted.success, true);

    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
    });
    const baseUrl = await listen(server);

    try {
        const response = await getJson(
            baseUrl,
            '/v1/admin/audit-events/cross-service',
            'admin-secret',
        );

        assert.equal(response.status, 200);
        const events = response.body.events as Array<Record<string, unknown>>;

        assert.equal(events.length > 0, true);
        assert.equal(events[0].contract_version, 'audit.contracts.v1');
        assert.equal(events[0].schema_version, 'audit.event.v1');
        const hasTokenMintSucceeded = events.some((event) =>
            event.action === 'token_minted' &&
            event.outcome === 'accepted'
        );

        assert.equal(hasTokenMintSucceeded, true);
    } finally {
        await closeServer(server);
    }
});

test('rotation completion requires adopted next secret', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);

    const server = createControlPlaneServer(fixture.control_plane.services, {
        adminToken: 'admin-secret',
    });
    const baseUrl = await listen(server);

    try {
        const started = await postJson(
            baseUrl,
            `/v1/admin/instances/${credentials.instance_id}/rotate-secret`,
            {
                overlap_seconds: 600,
            },
            'admin-secret',
        );

        assert.equal(started.status, 200);
        const nextSecret = String(started.body.next_client_secret);
        const nextVersion = String(started.body.next_secret_version_id);
        assert.ok(nextSecret.startsWith('sec_'));
        assert.ok(nextVersion.startsWith('sv_'));

        const completeBeforeAdoption = await postJson(
            baseUrl,
            `/v1/admin/instances/${credentials.instance_id}/complete-rotation`,
            {},
            'admin-secret',
        );

        assert.equal(completeBeforeAdoption.status, 409);
        assert.equal(
            completeBeforeAdoption.body.reason_code,
            'secret_rotation_not_adopted',
        );

        const adoptMint = await postJson(
            baseUrl,
            '/v1/auth/token',
            {
                client_id: credentials.client_id,
                client_secret: nextSecret,
                service_scope: 'reg',
            },
        );

        assert.equal(adoptMint.status, 200);

        const completeAfterAdoption = await postJson(
            baseUrl,
            `/v1/admin/instances/${credentials.instance_id}/complete-rotation`,
            {},
            'admin-secret',
        );

        assert.equal(completeAfterAdoption.status, 200);
        assert.equal(
            completeAfterAdoption.body.new_secret_version_id,
            nextVersion,
        );
    } finally {
        await closeServer(server);
    }
});

// ──────────────────────────────────────────────────
// Stage 11 — Admin Extended Coverage
// ──────────────────────────────────────────────────

describe('Admin endpoints — extended coverage', () => {
    describe('POST /v1/admin/tenants', () => {
        test('creates tenant and returns 201 with '
            + 'record', async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/admin/tenants',
                    {
                        tenant_id: 't1',
                        name: 'Tenant One',
                    },
                    'admin-secret'
                );
                assert.equal(r.status, 201);
                const tenant = r.body.tenant as
                    Record<string, unknown>;
                assert.equal(tenant.tenant_id, 't1');
                assert.equal(tenant.state, 'active');
            } finally {
                await closeServer(server);
            }
        });

        test('missing tenant_id returns 400',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/admin/tenants',
                    { name: 'No ID' },
                    'admin-secret'
                );
                assert.equal(r.status, 400);
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/admin/instances', () => {
        test('creates instance and returns 201 with '
            + 'record', async () => {
            const fixture = createFixture();
            await fixture.control_plane.services
                .registry.createTenant({
                    tenant_id: 't1',
                    name: 'T',
                });
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/admin/instances',
                    {
                        instance_id: 'i1',
                        tenant_id: 't1',
                        source: 'sn://dev.sn.com',
                    },
                    'admin-secret'
                );
                assert.equal(r.status, 201);
                const inst = r.body.instance as
                    Record<string, unknown>;
                assert.equal(inst.instance_id, 'i1');
            } finally {
                await closeServer(server);
            }
        });

        test('missing required fields returns 400',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/admin/instances',
                    { instance_id: 'i1' },
                    'admin-secret'
                );
                assert.equal(r.status, 400);
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/admin/enrollment-codes', () => {
        test('issues code and returns 201 with '
            + 'code_id', async () => {
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
                    source: 'sn://dev.sn.com',
                });
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/admin/enrollment-codes',
                    {
                        tenant_id: 't1',
                        instance_id: 'i1',
                    },
                    'admin-secret'
                );
                assert.equal(r.status, 201);
                assert.ok(
                    String(r.body.code_id)
                        .startsWith('enr_')
                );
            } finally {
                await closeServer(server);
            }
        });

        test('missing required fields returns 400',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/admin/enrollment-codes',
                    { tenant_id: 't1' },
                    'admin-secret'
                );
                assert.equal(r.status, 400);
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/admin/instances/{id}/services',
        () => {
        test('updates services and returns 200',
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
                    source: 'sn://dev.sn.com',
                });
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/admin/instances/i1/services',
                    { allowed_services: ['reg'] },
                    'admin-secret'
                );
                assert.equal(r.status, 200);
                const inst = r.body.instance as
                    Record<string, unknown>;
                assert.deepStrictEqual(
                    inst.allowed_services,
                    ['reg']
                );
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/admin/tenants/{id}/state', () => {
        test('updates tenant state and returns 200',
            async () => {
            const fixture = createFixture();
            await fixture.control_plane.services
                .registry.createTenant({
                    tenant_id: 't1',
                    name: 'T',
                });
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/admin/tenants/t1/state',
                    { state: 'suspended' },
                    'admin-secret'
                );
                assert.equal(r.status, 200);
                const tenant = r.body.tenant as
                    Record<string, unknown>;
                assert.equal(
                    tenant.state,
                    'suspended'
                );
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/admin/tenants/{id}/'
        + 'entitlement-state', () => {
        test('updates entitlement and returns 200',
            async () => {
            const fixture = createFixture();
            await fixture.control_plane.services
                .registry.createTenant({
                    tenant_id: 't1',
                    name: 'T',
                });
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/admin/tenants/t1/'
                        + 'entitlement-state',
                    { entitlement_state: 'disabled' },
                    'admin-secret'
                );
                assert.equal(r.status, 200);
                const tenant = r.body.tenant as
                    Record<string, unknown>;
                assert.equal(
                    tenant.entitlement_state,
                    'disabled'
                );
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('GET /v1/admin/degraded-mode', () => {
        test('returns current outage state and '
            + 'counters', async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminToken: 'admin-secret' }
                );
            const baseUrl = await listen(server);

            try {
                const r = await getJson(
                    baseUrl,
                    '/v1/admin/degraded-mode',
                    'admin-secret'
                );
                assert.equal(r.status, 200);
                assert.equal(
                    r.body.outage_active,
                    false
                );
                assert.ok(
                    r.body.degraded_mode_counters
                );
            } finally {
                await closeServer(server);
            }
        });
    });
});
