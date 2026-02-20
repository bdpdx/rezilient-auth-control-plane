import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
    bootstrapRegistryAndCredentials,
    createFixture,
} from '../test-helpers';

interface MintMatrixCase {
    case_name: string;
    mutate: (
        fixture: ReturnType<typeof createFixture>,
        credentials: Awaited<ReturnType<typeof bootstrapRegistryAndCredentials>>,
    ) => Promise<{
        client_id: string;
        client_secret: string;
        service_scope: string;
        grant_type?: string;
    }>;
    expected_success: boolean;
    expected_reason?: string;
}

test('TokenService mint decision matrix covers allow + deny paths', async () => {
    const matrix: MintMatrixCase[] = [
        {
            case_name: 'allow reg scope',
            mutate: async (_fixture, credentials) => ({
                client_id: credentials.client_id,
                client_secret: credentials.client_secret,
                service_scope: 'reg',
                grant_type: 'client_credentials',
            }),
            expected_success: true,
        },
        {
            case_name: 'allow rrs scope',
            mutate: async (_fixture, credentials) => ({
                client_id: credentials.client_id,
                client_secret: credentials.client_secret,
                service_scope: 'rrs',
                grant_type: 'client_credentials',
            }),
            expected_success: true,
        },
        {
            case_name: 'deny wrong grant type',
            mutate: async (_fixture, credentials) => ({
                client_id: credentials.client_id,
                client_secret: credentials.client_secret,
                service_scope: 'reg',
                grant_type: 'password',
            }),
            expected_success: false,
            expected_reason: 'denied_invalid_grant',
        },
        {
            case_name: 'deny bad secret',
            mutate: async (_fixture, credentials) => ({
                client_id: credentials.client_id,
                client_secret: 'sec_invalid',
                service_scope: 'reg',
            }),
            expected_success: false,
            expected_reason: 'denied_invalid_secret',
        },
        {
            case_name: 'deny service not allowed',
            mutate: async (ctx, credentials) => {
                await ctx.control_plane.services.registry.setInstanceAllowedServices(
                    credentials.instance_id,
                    ['reg'],
                );

                return {
                    client_id: credentials.client_id,
                    client_secret: credentials.client_secret,
                    service_scope: 'rrs',
                };
            },
            expected_success: false,
            expected_reason: 'denied_service_not_allowed',
        },
        {
            case_name: 'deny suspended instance',
            mutate: async (ctx, credentials) => {
                await ctx.control_plane.services.registry.setInstanceState(
                    credentials.instance_id,
                    'suspended',
                );

                return {
                    client_id: credentials.client_id,
                    client_secret: credentials.client_secret,
                    service_scope: 'reg',
                };
            },
            expected_success: false,
            expected_reason: 'denied_instance_suspended',
        },
        {
            case_name: 'deny disabled tenant entitlement',
            mutate: async (ctx, credentials) => {
                await ctx.control_plane.services.registry.setTenantEntitlement(
                    credentials.tenant_id,
                    'disabled',
                );

                return {
                    client_id: credentials.client_id,
                    client_secret: credentials.client_secret,
                    service_scope: 'reg',
                };
            },
            expected_success: false,
            expected_reason: 'denied_tenant_not_entitled',
        },
        {
            case_name: 'deny during outage mode',
            mutate: async (ctx, credentials) => {
                await ctx.control_plane.services.token.setOutageMode(true);

                return {
                    client_id: credentials.client_id,
                    client_secret: credentials.client_secret,
                    service_scope: 'reg',
                };
            },
            expected_success: false,
            expected_reason: 'denied_auth_control_plane_outage',
        },
    ];

    for (const matrixCase of matrix) {
        const caseSlug = matrixCase.case_name.replace(/\s+/g, '-');
        const caseFixture = createFixture();
        const caseCredentials = await bootstrapRegistryAndCredentials(caseFixture, {
            tenant_id: `tenant-${caseSlug}`,
            instance_id: `instance-${caseSlug}`,
            source: `sn://${caseSlug}.service-now.com`,
        });
        const request = await matrixCase.mutate(caseFixture, caseCredentials);

        const result = await caseFixture.control_plane.services.token.mintToken(
            request,
        );

        assert.equal(
            result.success,
            matrixCase.expected_success,
            matrixCase.case_name,
        );

        if (!result.success) {
            assert.equal(result.reason_code, matrixCase.expected_reason);
        }
    }
});

test('TokenService validates service-scoped tokens', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);
    const mint = await fixture.control_plane.services.token.mintToken({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'rrs',
    });

    assert.equal(mint.success, true);

    if (!mint.success) {
        return;
    }

    const valid = await fixture.control_plane.services.token.validateToken({
        access_token: mint.access_token,
        expected_service_scope: 'rrs',
    });

    assert.equal(valid.success, true);

    const invalidScope = await fixture.control_plane.services.token.validateToken({
        access_token: mint.access_token,
        expected_service_scope: 'reg',
    });

    assert.equal(invalidScope.success, false);
    if (invalidScope.success) {
        return;
    }

    assert.equal(
        invalidScope.reason_code,
        'denied_token_wrong_service_scope',
    );
});

test('TokenService emits refresh audit event when flow=refresh', async () => {
    const fixture = createFixture();
    const credentials = await bootstrapRegistryAndCredentials(fixture);
    const result = await fixture.control_plane.services.token.mintToken({
        flow: 'refresh',
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        service_scope: 'reg',
    });

    assert.equal(result.success, true);

    const events = await fixture.control_plane.services.audit.list();
    const hasRefreshEvent = events.some(
        (event) => event.event_type === 'token_refreshed',
    );

    assert.equal(hasRefreshEvent, true);
});
