import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
    buildTokenServiceConfigFromEnv,
    loadControlPlaneRuntimeConfig,
} from './index';

function buildEnv(
    overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
    return {
        AUTH_SIGNING_KEY: '0123456789abcdef0123456789abcdef',
        AUTH_ENABLE_ADMIN_ENDPOINTS: 'true',
        AUTH_ADMIN_TOKEN: 'admin-token-0123456789abcdef',
        AUTH_PERSISTENCE_PG_URL: 'postgres://local:local@127.0.0.1:5432/rez_auth_control_plane',
        ...overrides,
    };
}

test('startup config fails when AUTH_SIGNING_KEY is missing', () => {
    assert.throws(() => {
        loadControlPlaneRuntimeConfig(buildEnv({
            AUTH_SIGNING_KEY: undefined,
        }));
    }, /AUTH_SIGNING_KEY is required/);
});

test('startup config fails when admin API is enabled without AUTH_ADMIN_TOKEN', () => {
    assert.throws(() => {
        loadControlPlaneRuntimeConfig(buildEnv({
            AUTH_ADMIN_TOKEN: undefined,
        }));
    }, /AUTH_ADMIN_TOKEN is required when AUTH_ENABLE_ADMIN_ENDPOINTS=true/);
});

test('startup config allows omitted AUTH_ADMIN_TOKEN when admin API is disabled', () => {
    const config = loadControlPlaneRuntimeConfig(buildEnv({
        AUTH_ENABLE_ADMIN_ENDPOINTS: 'false',
        AUTH_ADMIN_TOKEN: undefined,
    }));

    assert.equal(config.admin_api_enabled, false);
    assert.equal(config.admin_token, undefined);
});

test('startup config fails when AUTH_PERSISTENCE_PG_URL is missing', () => {
    assert.throws(() => {
        loadControlPlaneRuntimeConfig(buildEnv({
            AUTH_PERSISTENCE_PG_URL: undefined,
        }));
    }, /AUTH_PERSISTENCE_PG_URL is required/);
});

// ──────────────────────────────────────────────────
// Stage 12 — Config Parsing Extended
// ──────────────────────────────────────────────────

describe('Config parsing — extended', () => {
    test('TOKEN_TTL_SECONDS parsed as positive integer',
        () => {
        const config = loadControlPlaneRuntimeConfig(
            buildEnv({
                TOKEN_TTL_SECONDS: '600',
            })
        );
        assert.equal(
            config.token_config.token_ttl_seconds,
            600
        );
    });

    test('TOKEN_TTL_SECONDS rejects zero', () => {
        assert.throws(() => {
            loadControlPlaneRuntimeConfig(buildEnv({
                TOKEN_TTL_SECONDS: '0',
            }));
        }, /TOKEN_TTL_SECONDS must be a positive integer/);
    });

    test('TOKEN_TTL_SECONDS rejects non-numeric', () => {
        assert.throws(() => {
            loadControlPlaneRuntimeConfig(buildEnv({
                TOKEN_TTL_SECONDS: 'abc',
            }));
        }, /TOKEN_TTL_SECONDS must be a positive integer/);
    });

    test('TOKEN_CLOCK_SKEW_SECONDS uses default when '
        + 'omitted', () => {
        const config = loadControlPlaneRuntimeConfig(
            buildEnv({})
        );
        assert.equal(
            config.token_config.token_clock_skew_seconds,
            30
        );
    });

    test('OUTAGE_GRACE_WINDOW_SECONDS uses default '
        + 'when omitted', () => {
        const config = loadControlPlaneRuntimeConfig(
            buildEnv({})
        );
        assert.equal(
            config.token_config
                .outage_grace_window_seconds,
            120
        );
    });

    test('AUTH_ENABLE_ADMIN_ENDPOINTS parses true and '
        + 'false', () => {
        const configTrue =
            loadControlPlaneRuntimeConfig(buildEnv({
                AUTH_ENABLE_ADMIN_ENDPOINTS: 'true',
            }));
        assert.equal(
            configTrue.admin_api_enabled,
            true
        );
        const configFalse =
            loadControlPlaneRuntimeConfig(buildEnv({
                AUTH_ENABLE_ADMIN_ENDPOINTS: 'false',
                AUTH_ADMIN_TOKEN: undefined,
            }));
        assert.equal(
            configFalse.admin_api_enabled,
            false
        );
    });

    test('AUTH_ENABLE_ADMIN_ENDPOINTS rejects invalid '
        + 'string', () => {
        assert.throws(() => {
            loadControlPlaneRuntimeConfig(buildEnv({
                AUTH_ENABLE_ADMIN_ENDPOINTS: 'yes',
            }));
        }, /AUTH_ENABLE_ADMIN_ENDPOINTS must be "true" or "false"/);
    });

    test('AUTH_SIGNING_KEY rejects short key '
        + '(< 32 chars)', () => {
        assert.throws(() => {
            loadControlPlaneRuntimeConfig(buildEnv({
                AUTH_SIGNING_KEY: 'short',
            }));
        }, /at least 32 characters/);
    });

    test('AUTH_SIGNING_KEY accepts exactly 32 chars',
        () => {
        const config = loadControlPlaneRuntimeConfig(
            buildEnv({
                AUTH_SIGNING_KEY:
                    '01234567890123456789012345678901',
            })
        );
        assert.equal(
            config.token_config.signing_key,
            '01234567890123456789012345678901'
        );
    });

    test('loadControlPlaneRuntimeConfig returns all '
        + 'fields with full env', () => {
        const config = loadControlPlaneRuntimeConfig(
            buildEnv({
                PORT: '4000',
                TOKEN_TTL_SECONDS: '600',
                TOKEN_CLOCK_SKEW_SECONDS: '60',
                OUTAGE_GRACE_WINDOW_SECONDS: '240',
            })
        );
        assert.equal(config.port, 4000);
        assert.equal(
            config.token_config.token_ttl_seconds,
            600
        );
        assert.equal(
            config.token_config.token_clock_skew_seconds,
            60
        );
        assert.equal(
            config.token_config
                .outage_grace_window_seconds,
            240
        );
        assert.ok(config.persistence_pg_url);
    });

    test('buildTokenServiceConfigFromEnv builds config '
        + 'from full environment', () => {
        const config = buildTokenServiceConfigFromEnv({
            AUTH_SIGNING_KEY:
                'test-key-0123456789abcdef01234567',
            AUTH_ISSUER: 'custom-issuer',
            TOKEN_TTL_SECONDS: '900',
            TOKEN_CLOCK_SKEW_SECONDS: '45',
            OUTAGE_GRACE_WINDOW_SECONDS: '180',
        });
        assert.equal(config.issuer, 'custom-issuer');
        assert.equal(config.token_ttl_seconds, 900);
        assert.equal(
            config.token_clock_skew_seconds,
            45
        );
        assert.equal(
            config.outage_grace_window_seconds,
            180
        );
    });

    test('buildTokenServiceConfigFromEnv uses defaults '
        + 'for optional values', () => {
        const config = buildTokenServiceConfigFromEnv({
            AUTH_SIGNING_KEY:
                'test-key-0123456789abcdef01234567',
        });
        assert.equal(
            config.issuer,
            'rezilient-auth-control-plane'
        );
        assert.equal(config.token_ttl_seconds, 300);
        assert.equal(
            config.token_clock_skew_seconds,
            30
        );
        assert.equal(
            config.outage_grace_window_seconds,
            120
        );
    });
});
