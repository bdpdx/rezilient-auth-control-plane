import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadControlPlaneRuntimeConfig } from './index';

function buildEnv(
    overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
    return {
        AUTH_SIGNING_KEY: '0123456789abcdef0123456789abcdef',
        AUTH_ENABLE_ADMIN_ENDPOINTS: 'true',
        AUTH_ADMIN_TOKEN: 'admin-token-0123456789abcdef',
        AUTH_PERSISTENCE_DB_PATH: '/tmp/rez-auth-control-plane.test.sqlite',
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

test('startup config fails when AUTH_PERSISTENCE_DB_PATH is missing', () => {
    assert.throws(() => {
        loadControlPlaneRuntimeConfig(buildEnv({
            AUTH_PERSISTENCE_DB_PATH: undefined,
        }));
    }, /AUTH_PERSISTENCE_DB_PATH is required/);
});
