import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
    bootstrapRegistryAndCredentials,
    createFixture,
} from '../test-helpers';
import { verifyJwt } from '../utils/crypto';

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

test('TokenService rejects tokens with wrong issuer', async () => {
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

    const { createInMemoryControlPlane } = await import('../index');
    const { FixedClock } = await import('../utils/clock');
    const differentIssuerClock = new FixedClock('2026-02-16T12:00:00.000Z');
    const differentIssuerPlane = createInMemoryControlPlane(
        differentIssuerClock,
        {
            issuer: 'different-issuer',
            signing_key: 'test-signing-key-0123456789abcdef',
            token_ttl_seconds: 300,
            token_clock_skew_seconds: 30,
            outage_grace_window_seconds: 120,
        },
    );

    const result = await differentIssuerPlane.services.token.validateToken({
        access_token: mint.access_token,
    });

    assert.equal(result.success, false);

    if (!result.success) {
        assert.equal(result.reason_code, 'denied_token_malformed');
    }
});

// ──────────────────────────────────────────────────
// Stage 8 — Token Expiration, Clock Skew, Claims
// ──────────────────────────────────────────────────

describe('TokenService — extended coverage', () => {
    describe('token expiration and TTL', () => {
        test('minted token exp claim equals '
            + 'iat + ttl_seconds', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(result.success, true);
            if (!result.success) { return; }
            const verified = verifyJwt(
                result.access_token,
                'test-signing-key-0123456789abcdef'
            );
            assert.ok(verified.valid);
            const p = verified.payload!;
            assert.equal(
                (p.exp as number) - (p.iat as number),
                300
            );
        });

        test('expired token rejected during validation',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(result.success, true);
            if (!result.success) { return; }
            // Advance past TTL + skew
            fixture.clock.advanceSeconds(300 + 30 + 1);
            const v =
                await fixture.control_plane.services
                    .token.validateToken({
                        access_token: result.access_token,
                    });
            assert.equal(v.success, false);
            if (!v.success) {
                assert.equal(
                    v.reason_code,
                    'denied_token_expired'
                );
            }
        });

        test('token valid within clock_skew_seconds '
            + 'of expiry', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(result.success, true);
            if (!result.success) { return; }
            // Advance to TTL + skew - 1 (still valid)
            fixture.clock.advanceSeconds(300 + 30 - 1);
            const v =
                await fixture.control_plane.services
                    .token.validateToken({
                        access_token: result.access_token,
                    });
            assert.equal(v.success, true);
        });

        test('token rejected beyond clock_skew_seconds '
            + 'of expiry', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(result.success, true);
            if (!result.success) { return; }
            fixture.clock.advanceSeconds(300 + 31);
            const v =
                await fixture.control_plane.services
                    .token.validateToken({
                        access_token: result.access_token,
                    });
            assert.equal(v.success, false);
        });
    });

    describe('token claims structure', () => {
        test('all required claims present in minted '
            + 'token', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(result.success, true);
            if (!result.success) { return; }
            const verified = verifyJwt(
                result.access_token,
                'test-signing-key-0123456789abcdef'
            );
            const p = verified.payload!;
            const required = [
                'iss', 'sub', 'aud', 'jti',
                'iat', 'exp', 'service_scope',
                'tenant_id', 'instance_id', 'source',
            ];
            for (const key of required) {
                assert.ok(
                    key in p,
                    `missing claim: ${key}`
                );
            }
        });

        test('sub equals client_id', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(result.success, true);
            if (!result.success) { return; }
            const p = verifyJwt(
                result.access_token,
                'test-signing-key-0123456789abcdef'
            ).payload!;
            assert.equal(p.sub, creds.client_id);
        });

        test('aud equals service_scope', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'rrs',
                    });
            assert.equal(result.success, true);
            if (!result.success) { return; }
            const p = verifyJwt(
                result.access_token,
                'test-signing-key-0123456789abcdef'
            ).payload!;
            assert.equal(p.aud, 'rezilient:rrs');
        });

        test('jti is unique per mint call', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const r1 =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            const r2 =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(r1.success, true);
            assert.equal(r2.success, true);
            if (!r1.success || !r2.success) { return; }
            const p1 = verifyJwt(
                r1.access_token,
                'test-signing-key-0123456789abcdef'
            ).payload!;
            const p2 = verifyJwt(
                r2.access_token,
                'test-signing-key-0123456789abcdef'
            ).payload!;
            assert.notEqual(p1.jti, p2.jti);
        });

        test('iss matches configured issuer', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(result.success, true);
            if (!result.success) { return; }
            const p = verifyJwt(
                result.access_token,
                'test-signing-key-0123456789abcdef'
            ).payload!;
            assert.equal(
                p.iss,
                'rezilient-auth-control-plane-test'
            );
        });
    });

    describe('validation with malformed claims', () => {
        test('token missing exp claim rejected as '
            + 'malformed', async () => {
            const fixture = createFixture();
            const { signJwt } = await import(
                '../utils/crypto'
            );
            const token = signJwt(
                { iss: 'test', sub: 'x' },
                'test-signing-key-0123456789abcdef'
            );
            const v =
                await fixture.control_plane.services
                    .token.validateToken({
                        access_token: token,
                    });
            assert.equal(v.success, false);
            if (!v.success) {
                assert.equal(
                    v.reason_code,
                    'denied_token_malformed'
                );
            }
        });

        test('token with non-string service_scope '
            + 'rejected', async () => {
            const fixture = createFixture();
            const { signJwt } = await import(
                '../utils/crypto'
            );
            const token = signJwt(
                {
                    iss: 'rezilient-auth-control-'
                        + 'plane-test',
                    sub: 'x',
                    aud: 'rezilient:reg',
                    jti: 'tok_abc',
                    iat: 1000,
                    exp: 2000,
                    service_scope: 123,
                    tenant_id: 't1',
                    instance_id: 'i1',
                    source: 'sn://test',
                },
                'test-signing-key-0123456789abcdef'
            );
            const v =
                await fixture.control_plane.services
                    .token.validateToken({
                        access_token: token,
                    });
            assert.equal(v.success, false);
            if (!v.success) {
                assert.equal(
                    v.reason_code,
                    'denied_token_malformed'
                );
            }
        });
    });

    describe('secret matching edge cases', () => {
        test('only current secret works when no next '
            + 'secret', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(result.success, true);
        });

        test('revoked secret rejected with '
            + 'denied_invalid_secret', async () => {
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
                    reason: 'test',
                });
            const result =
                await fixture.control_plane.services
                    .token.mintToken({
                        client_id: creds.client_id,
                        client_secret: creds.client_secret,
                        service_scope: 'reg',
                    });
            assert.equal(result.success, false);
            if (!result.success) {
                assert.equal(
                    result.reason_code,
                    'denied_invalid_secret'
                );
            }
        });
    });

    describe('outage mode toggle', () => {
        test('setOutageMode toggles isOutageModeActive',
            async () => {
            const fixture = createFixture();
            assert.equal(
                await fixture.control_plane.services
                    .token.isOutageModeActive(),
                false
            );
            await fixture.control_plane.services
                .token.setOutageMode(true);
            assert.equal(
                await fixture.control_plane.services
                    .token.isOutageModeActive(),
                true
            );
            await fixture.control_plane.services
                .token.setOutageMode(false);
            assert.equal(
                await fixture.control_plane.services
                    .token.isOutageModeActive(),
                false
            );
        });

        test('emits control_plane_outage_mode_changed '
            + 'audit event', async () => {
            const fixture = createFixture();
            await fixture.control_plane.services
                .token.setOutageMode(true);
            const events =
                await fixture.control_plane.services
                    .audit.list();
            const evt = events.find(
                (e) => e.event_type ===
                    'control_plane_outage_mode_changed'
            );
            assert.ok(evt);
        });
    });
});

// ──────────────────────────────────────────────────
// Stage 9 — In-Flight and Grace Window Edge Cases
// ──────────────────────────────────────────────────

describe('TokenService — in-flight and grace edge cases',
    () => {
    describe('evaluateRefreshDuringOutage', () => {
        test('exact grace window boundary — action is '
            + 'retry', async () => {
            const fixture = createFixture();
            const expiresAt =
                fixture.clock.now().toISOString();
            await fixture.control_plane.services
                .token.setOutageMode(true);
            // Grace window is 120s, at exact boundary
            // nowMs == expiryMs + graceMs
            fixture.clock.advanceSeconds(120);
            const decision =
                await fixture.control_plane.services
                    .token.evaluateRefreshDuringOutage(
                        expiresAt
                    );
            assert.equal(
                decision.action,
                'retry_within_grace'
            );
        });

        test('one second past grace window — action is '
            + 'pause', async () => {
            const fixture = createFixture();
            const expiresAt =
                fixture.clock.now().toISOString();
            await fixture.control_plane.services
                .token.setOutageMode(true);
            fixture.clock.advanceSeconds(121);
            const decision =
                await fixture.control_plane.services
                    .token.evaluateRefreshDuringOutage(
                        expiresAt
                    );
            assert.equal(
                decision.action,
                'pause_in_flight'
            );
            assert.equal(
                decision.reason_code,
                'paused_token_refresh_grace_exhausted'
            );
        });

        test('already-expired token with past expiry',
            async () => {
            const fixture = createFixture();
            // Expiry far in the past
            const pastExpiry =
                '2025-01-01T00:00:00.000Z';
            await fixture.control_plane.services
                .token.setOutageMode(true);
            const decision =
                await fixture.control_plane.services
                    .token.evaluateRefreshDuringOutage(
                        pastExpiry
                    );
            assert.equal(
                decision.action,
                'pause_in_flight'
            );
        });
    });

    describe('evaluateInFlightEntitlement', () => {
        test('active tenant + active instance = '
            + 'continue', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            const decision =
                await fixture.control_plane.services
                    .token.evaluateInFlightEntitlement(
                        creds.instance_id,
                        false
                    );
            assert.equal(decision.action, 'continue');
            assert.equal(
                decision.reason_code,
                'none'
            );
        });

        test('suspended tenant = continue until '
            + 'boundary', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await fixture.control_plane.services
                .registry.setTenantState(
                    creds.tenant_id,
                    'suspended'
                );
            const decision =
                await fixture.control_plane.services
                    .token.evaluateInFlightEntitlement(
                        creds.instance_id,
                        false
                    );
            assert.equal(
                decision.action,
                'continue_until_chunk_boundary'
            );
        });

        test('disabled tenant at boundary = pause',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await fixture.control_plane.services
                .registry.setTenantState(
                    creds.tenant_id,
                    'disabled'
                );
            const decision =
                await fixture.control_plane.services
                    .token.evaluateInFlightEntitlement(
                        creds.instance_id,
                        true
                    );
            assert.equal(decision.action, 'pause');
        });

        test('suspended instance = continue until '
            + 'boundary', async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await fixture.control_plane.services
                .registry.setInstanceState(
                    creds.instance_id,
                    'suspended'
                );
            const decision =
                await fixture.control_plane.services
                    .token.evaluateInFlightEntitlement(
                        creds.instance_id,
                        false
                    );
            assert.equal(
                decision.action,
                'continue_until_chunk_boundary'
            );
        });

        test('disabled instance at boundary = pause',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await fixture.control_plane.services
                .registry.setInstanceState(
                    creds.instance_id,
                    'disabled'
                );
            const decision =
                await fixture.control_plane.services
                    .token.evaluateInFlightEntitlement(
                        creds.instance_id,
                        true
                    );
            assert.equal(decision.action, 'pause');
        });

        test('re-enabled tenant = continue',
            async () => {
            const fixture = createFixture();
            const creds =
                await bootstrapRegistryAndCredentials(
                    fixture
                );
            await fixture.control_plane.services
                .registry.setTenantState(
                    creds.tenant_id,
                    'suspended'
                );
            await fixture.control_plane.services
                .registry.setTenantState(
                    creds.tenant_id,
                    'active'
                );
            const decision =
                await fixture.control_plane.services
                    .token.evaluateInFlightEntitlement(
                        creds.instance_id,
                        false
                    );
            assert.equal(decision.action, 'continue');
        });

        test('unknown instance returns appropriate '
            + 'decision', async () => {
            const fixture = createFixture();
            const decision =
                await fixture.control_plane.services
                    .token.evaluateInFlightEntitlement(
                        'nonexistent',
                        true
                    );
            assert.equal(decision.action, 'pause');
            assert.equal(
                decision.reason_code,
                'paused_instance_disabled'
            );
        });
    });
});
