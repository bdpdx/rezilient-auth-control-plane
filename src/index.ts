import { createControlPlaneServer, ControlPlaneServices } from './server';
import { AuditService } from './audit/audit.service';
import { EnrollmentService } from './enrollment/enrollment.service';
import { RegistryService } from './registry/registry.service';
import { RotationService } from './rotation/rotation.service';
import {
    TokenService,
    TokenServiceConfig,
} from './token/token.service';
import {
    Clock,
    SystemClock,
} from './utils/clock';

const DEFAULT_PORT = 3010;
const DEFAULT_AUTH_ISSUER = 'rezilient-auth-control-plane';
const DEFAULT_TOKEN_TTL_SECONDS = 300;
const DEFAULT_TOKEN_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_OUTAGE_GRACE_WINDOW_SECONDS = 120;
const DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576;
const MIN_SIGNING_KEY_LENGTH = 32;

function parseIntConfig(
    value: string | undefined,
    defaultValue: number,
    keyName: string,
): number {
    if (!value) {
        return defaultValue;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${keyName} must be a positive integer`);
    }

    return parsed;
}

function parseBooleanConfig(
    value: string | undefined,
    defaultValue: boolean,
    keyName: string,
): boolean {
    if (!value) {
        return defaultValue;
    }

    if (value === 'true') {
        return true;
    }

    if (value === 'false') {
        return false;
    }

    throw new Error(`${keyName} must be "true" or "false"`);
}

function parseRequiredSecretConfig(
    value: string | undefined,
    keyName: string,
): string {
    if (!value || value.trim().length === 0) {
        throw new Error(`${keyName} is required`);
    }

    if (value.length < MIN_SIGNING_KEY_LENGTH) {
        throw new Error(
            `${keyName} must be at least ${MIN_SIGNING_KEY_LENGTH} characters`,
        );
    }

    return value;
}

function parseOptionalToken(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
        return undefined;
    }

    return trimmed;
}

export interface ControlPlaneRuntimeConfig {
    port: number;
    token_config: TokenServiceConfig;
    admin_api_enabled: boolean;
    admin_token?: string;
    max_json_body_bytes: number;
}

export function buildTokenServiceConfigFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): TokenServiceConfig {
    return {
        issuer: env.AUTH_ISSUER || DEFAULT_AUTH_ISSUER,
        signing_key: parseRequiredSecretConfig(
            env.AUTH_SIGNING_KEY,
            'AUTH_SIGNING_KEY',
        ),
        token_ttl_seconds: parseIntConfig(
            env.TOKEN_TTL_SECONDS,
            DEFAULT_TOKEN_TTL_SECONDS,
            'TOKEN_TTL_SECONDS',
        ),
        token_clock_skew_seconds: parseIntConfig(
            env.TOKEN_CLOCK_SKEW_SECONDS,
            DEFAULT_TOKEN_CLOCK_SKEW_SECONDS,
            'TOKEN_CLOCK_SKEW_SECONDS',
        ),
        outage_grace_window_seconds: parseIntConfig(
            env.OUTAGE_GRACE_WINDOW_SECONDS,
            DEFAULT_OUTAGE_GRACE_WINDOW_SECONDS,
            'OUTAGE_GRACE_WINDOW_SECONDS',
        ),
    };
}

export function loadControlPlaneRuntimeConfig(
    env: NodeJS.ProcessEnv = process.env,
): ControlPlaneRuntimeConfig {
    const adminApiEnabled = parseBooleanConfig(
        env.AUTH_ENABLE_ADMIN_ENDPOINTS,
        true,
        'AUTH_ENABLE_ADMIN_ENDPOINTS',
    );
    const adminToken = parseOptionalToken(env.AUTH_ADMIN_TOKEN);

    if (adminApiEnabled && !adminToken) {
        throw new Error(
            'AUTH_ADMIN_TOKEN is required when AUTH_ENABLE_ADMIN_ENDPOINTS=true',
        );
    }

    return {
        port: parseIntConfig(
            env.PORT,
            DEFAULT_PORT,
            'PORT',
        ),
        token_config: buildTokenServiceConfigFromEnv(env),
        admin_api_enabled: adminApiEnabled,
        admin_token: adminToken,
        max_json_body_bytes: parseIntConfig(
            env.AUTH_MAX_JSON_BODY_BYTES,
            DEFAULT_MAX_JSON_BODY_BYTES,
            'AUTH_MAX_JSON_BODY_BYTES',
        ),
    };
}

export interface InMemoryControlPlane {
    services: ControlPlaneServices;
    token_config: TokenServiceConfig;
}

export function createInMemoryControlPlane(
    clock?: Clock,
    tokenConfig?: TokenServiceConfig,
): InMemoryControlPlane {
    const runtimeClock = clock ?? new SystemClock();
    const resolvedTokenConfig = tokenConfig ?? buildTokenServiceConfigFromEnv();
    const audit = new AuditService(runtimeClock);
    const registry = new RegistryService(audit, runtimeClock);
    const enrollment = new EnrollmentService(registry, audit, runtimeClock);
    const rotation = new RotationService(registry, audit, runtimeClock);
    const token = new TokenService(
        registry,
        rotation,
        audit,
        runtimeClock,
        resolvedTokenConfig,
    );

    return {
        services: {
            registry,
            enrollment,
            rotation,
            token,
            audit,
        },
        token_config: resolvedTokenConfig,
    };
}

if (require.main === module) {
    const runtimeConfig = loadControlPlaneRuntimeConfig();
    const controlPlane = createInMemoryControlPlane(
        undefined,
        runtimeConfig.token_config,
    );
    const server = createControlPlaneServer(
        controlPlane.services,
        {
            adminApiEnabled: runtimeConfig.admin_api_enabled,
            adminToken: runtimeConfig.admin_token,
            maxJsonBodyBytes: runtimeConfig.max_json_body_bytes,
        },
    );
    const port = runtimeConfig.port;

    server.listen(port, () => {
        process.stdout.write(
            `rezilient-auth-control-plane listening on port ${port}\n`,
        );
    });
}

export {
    AuditService,
    EnrollmentService,
    RegistryService,
    RotationService,
    TokenService,
};
