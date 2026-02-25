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
        throw new Error('failed to bind test server');
    }

    return `http://127.0.0.1:${address.port}`;
}

async function closeServer(
    server: Server,
): Promise<void> {
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}

async function postJson(
    baseUrl: string,
    path: string,
    body: Record<string, unknown>,
): Promise<ResponseData> {
    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    return {
        status: response.status,
        body: await response.json() as
            Record<string, unknown>,
    };
}

async function getJson(
    baseUrl: string,
    path: string,
): Promise<ResponseData> {
    const response = await fetch(`${baseUrl}${path}`, {
        method: 'GET',
    });

    return {
        status: response.status,
        body: await response.json() as
            Record<string, unknown>,
    };
}

// ──────────────────────────────────────────────────
// Stage 10 — Public Endpoints
// ──────────────────────────────────────────────────

describe('Control Plane Server — public endpoints',
    () => {
    describe('GET /v1/health', () => {
        test('returns 200 with ok=true', async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await getJson(
                    baseUrl,
                    '/v1/health'
                );
                assert.equal(r.status, 200);
                assert.equal(r.body.ok, true);
                assert.equal(
                    r.body.outage_active,
                    false
                );
            } finally {
                await closeServer(server);
            }
        });

        test('reflects outage_active=true when set',
            async () => {
            const fixture = createFixture();
            await fixture.control_plane.services
                .token.setOutageMode(true);
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await getJson(
                    baseUrl,
                    '/v1/health'
                );
                assert.equal(r.status, 200);
                assert.equal(
                    r.body.outage_active,
                    true
                );
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/analytics/instance-launch', () => {
        test('records launch telemetry once per idempotency key',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const first = await postJson(
                    baseUrl,
                    '/v1/analytics/instance-launch',
                    {
                        instance_id: 'instance-dev-01',
                        source:
                            'sn://acme-dev.service-now.com',
                        idempotency_key:
                            'launch-instance-dev-01',
                        app_version: '1.2.3',
                    }
                );
                assert.equal(first.status, 200);
                assert.equal(first.body.status, 'recorded');
                assert.ok(first.body.reference_id);

                const second = await postJson(
                    baseUrl,
                    '/v1/analytics/instance-launch',
                    {
                        instance_id: 'instance-dev-01',
                        source:
                            'sn://acme-dev.service-now.com',
                        idempotency_key:
                            'launch-instance-dev-01',
                    }
                );
                assert.equal(second.status, 200);
                assert.equal(second.body.status, 'duplicate');
                assert.equal(
                    second.body.reference_id,
                    first.body.reference_id
                );

                const auditEvents =
                    await fixture.control_plane
                        .services.audit.list();
                const launchEvents = auditEvents.filter(
                    (event) =>
                        event.event_type ===
                        'instance_launch_reported'
                );
                assert.equal(launchEvents.length, 1);
            } finally {
                await closeServer(server);
            }
        });

        test('supports idempotency key via request header',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const response = await fetch(
                    `${baseUrl}/v1/analytics/instance-launch`,
                    {
                        method: 'POST',
                        headers: {
                            'content-type':
                                'application/json',
                            'x-rez-idempotency-key':
                                'launch-header-key-1',
                        },
                        body: JSON.stringify({
                            instance_id:
                                'instance-dev-02',
                            source:
                                'sn://acme-dev.service-now.com',
                        }),
                    }
                );
                const payload = await response.json() as
                    Record<string, unknown>;
                assert.equal(response.status, 200);
                assert.equal(payload.status, 'recorded');

                const retry = await fetch(
                    `${baseUrl}/v1/analytics/instance-launch`,
                    {
                        method: 'POST',
                        headers: {
                            'content-type':
                                'application/json',
                            'x-rez-idempotency-key':
                                'launch-header-key-1',
                        },
                        body: JSON.stringify({
                            instance_id:
                                'instance-dev-02',
                            source:
                                'sn://acme-dev.service-now.com',
                        }),
                    }
                );
                const retryPayload = await retry.json() as
                    Record<string, unknown>;
                assert.equal(retry.status, 200);
                assert.equal(retryPayload.status, 'duplicate');
                assert.equal(
                    retryPayload.reference_id,
                    payload.reference_id
                );
            } finally {
                await closeServer(server);
            }
        });

        test('returns 400 when required fields are missing',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const response = await postJson(
                    baseUrl,
                    '/v1/analytics/instance-launch',
                    {
                        source:
                            'sn://acme-dev.service-now.com',
                    }
                );
                assert.equal(response.status, 400);
                assert.equal(
                    response.body.reason_code,
                    'invalid_admin_request'
                );
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/onboarding/register-interest', () => {
        test('returns acknowledgement with reference and sales contact',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const response = await postJson(
                    baseUrl,
                    '/v1/onboarding/register-interest',
                    {
                        source:
                            'sn://prospect.service-now.com',
                        organization_name:
                            'Prospect Org',
                        contact_name:
                            'Pat Example',
                        contact_email:
                            'pat@example.com',
                        notes:
                            'Interested in enterprise plan.',
                    }
                );
                assert.equal(response.status, 201);
                assert.equal(response.body.status, 'received');
                assert.ok(response.body.reference_id);

                const salesContact =
                    response.body.sales_contact as
                    Record<string, unknown>;
                assert.equal(
                    salesContact.email,
                    'sales@rezilient.co'
                );
                assert.ok(salesContact.message);

                const auditEvents =
                    await fixture.control_plane
                        .services.audit.list();
                const interestEvents = auditEvents.filter(
                    (event) =>
                        event.event_type ===
                        'instance_interest_registered'
                );
                assert.equal(interestEvents.length, 1);
            } finally {
                await closeServer(server);
            }
        });

        test('returns 400 when required fields are missing',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const response = await postJson(
                    baseUrl,
                    '/v1/onboarding/register-interest',
                    {
                        source:
                            'sn://prospect.service-now.com',
                        contact_name:
                            'Pat Example',
                    }
                );
                assert.equal(response.status, 400);
                assert.equal(
                    response.body.reason_code,
                    'invalid_admin_request'
                );
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/auth/enroll/exchange', () => {
        test('successful exchange returns client_id '
            + 'and client_secret', async () => {
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
            const enrollment =
                await fixture.control_plane.services
                    .enrollment.issueEnrollmentCode({
                        tenant_id: 't1',
                        instance_id: 'i1',
                        ttl_seconds: 900,
                    });
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/enroll/exchange',
                    {
                        enrollment_code:
                            enrollment.enrollment_code,
                    }
                );
                assert.equal(r.status, 200);
                assert.equal(r.body.success, true);
                assert.ok(r.body.client_id);
                assert.ok(r.body.client_secret);
            } finally {
                await closeServer(server);
            }
        });

        test('invalid code returns 401 with '
            + 'reason_code', async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/enroll/exchange',
                    { enrollment_code: 'enroll_bad' }
                );
                assert.equal(r.status, 401);
                assert.equal(r.body.success, false);
                assert.ok(r.body.reason_code);
            } finally {
                await closeServer(server);
            }
        });

        test('missing enrollment_code field returns '
            + '400', async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/enroll/exchange',
                    {}
                );
                assert.equal(r.status, 400);
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/auth/token', () => {
        test('successful mint returns access_token '
            + 'and expires_in', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/token',
                    {
                        client_id: creds.client_id,
                        client_secret:
                            creds.client_secret,
                        service_scope: 'reg',
                    }
                );
                assert.equal(r.status, 200);
                assert.equal(r.body.success, true);
                assert.ok(r.body.access_token);
                assert.ok(r.body.expires_in);
            } finally {
                await closeServer(server);
            }
        });

        test('invalid credentials returns 401 with '
            + 'reason_code', async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/token',
                    {
                        client_id: 'cli_unknown',
                        client_secret: 'sec_bad',
                        service_scope: 'reg',
                    }
                );
                assert.equal(r.status, 401);
                assert.equal(r.body.success, false);
                assert.ok(r.body.reason_code);
            } finally {
                await closeServer(server);
            }
        });

        test('missing client_id returns 400',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/token',
                    {
                        client_secret: 'sec_x',
                        service_scope: 'reg',
                    }
                );
                assert.equal(r.status, 400);
            } finally {
                await closeServer(server);
            }
        });

        test('missing service_scope returns 400',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/token',
                    {
                        client_id: 'cli_x',
                        client_secret: 'sec_x',
                    }
                );
                assert.equal(r.status, 400);
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('POST /v1/auth/token/validate', () => {
        test('valid token returns claims', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const mint =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret:
                            creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(mint.success, true);
            if (!mint.success) { return; }
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/token/validate',
                    {
                        access_token:
                            mint.access_token,
                    }
                );
                assert.equal(r.status, 200);
                assert.equal(r.body.success, true);
                assert.ok(r.body.claims);
            } finally {
                await closeServer(server);
            }
        });

        test('invalid token returns 401 with '
            + 'reason_code', async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/token/validate',
                    { access_token: 'bad.token.here' }
                );
                assert.equal(r.status, 401);
                assert.equal(r.body.success, false);
                assert.ok(r.body.reason_code);
            } finally {
                await closeServer(server);
            }
        });

        test('missing token field returns 400',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await postJson(
                    baseUrl,
                    '/v1/auth/token/validate',
                    {}
                );
                assert.equal(r.status, 400);
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('routing', () => {
        test('unknown path returns 404', async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await getJson(
                    baseUrl,
                    '/v1/nonexistent'
                );
                assert.equal(r.status, 404);
            } finally {
                await closeServer(server);
            }
        });

        test('GET on POST-only endpoint returns '
            + 'appropriate error', async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services
                );
            const baseUrl = await listen(server);

            try {
                const r = await getJson(
                    baseUrl,
                    '/v1/auth/token'
                );
                assert.equal(r.status, 404);
            } finally {
                await closeServer(server);
            }
        });
    });

    describe('admin API disabled', () => {
        test('admin endpoints return 404 when disabled',
            async () => {
            const fixture = createFixture();
            const server =
                createControlPlaneServer(
                    fixture.control_plane.services,
                    { adminApiEnabled: false }
                );
            const baseUrl = await listen(server);

            try {
                const r = await getJson(
                    baseUrl,
                    '/v1/admin/tenants'
                );
                assert.equal(r.status, 404);
            } finally {
                await closeServer(server);
            }
        });
    });
});
