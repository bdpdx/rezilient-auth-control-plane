import { createControlPlaneServer, ControlPlaneServices } from './server';
import { AuditService } from './audit/audit.service';
import { EnrollmentService } from './enrollment/enrollment.service';
import { OnboardingService } from './onboarding/onboarding.service';
import { InMemoryControlPlaneStateStore } from './persistence/in-memory-state-store';
import { PostgresControlPlaneStateStore } from './persistence/postgres-state-store';
import { ControlPlaneStateStore } from './persistence/state-store';
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
const DEFAULT_PERSISTENCE_SNAPSHOT_KEY = 'default';
const DEFAULT_INTERNAL_API_ENABLED = true;
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

function parseRequiredStringConfig(
    value: string | undefined,
    keyName: string,
): string {
    if (!value || value.trim().length === 0) {
        throw new Error(`${keyName} is required`);
    }

    return value.trim();
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
    internal_api_enabled: boolean;
    internal_token?: string;
    max_json_body_bytes: number;
    persistence_pg_url: string;
    persistence_snapshot_key: string;
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
    const internalApiEnabled = parseBooleanConfig(
        env.AUTH_ENABLE_INTERNAL_ENDPOINTS,
        DEFAULT_INTERNAL_API_ENABLED,
        'AUTH_ENABLE_INTERNAL_ENDPOINTS',
    );
    const internalToken = parseOptionalToken(env.AUTH_INTERNAL_TOKEN);

    if (adminApiEnabled && !adminToken) {
        throw new Error(
            'AUTH_ADMIN_TOKEN is required when AUTH_ENABLE_ADMIN_ENDPOINTS=true',
        );
    }

    if (internalApiEnabled && !internalToken) {
        throw new Error(
            'AUTH_INTERNAL_TOKEN is required when '
            + 'AUTH_ENABLE_INTERNAL_ENDPOINTS=true',
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
        internal_api_enabled: internalApiEnabled,
        internal_token: internalToken,
        max_json_body_bytes: parseIntConfig(
            env.AUTH_MAX_JSON_BODY_BYTES,
            DEFAULT_MAX_JSON_BODY_BYTES,
            'AUTH_MAX_JSON_BODY_BYTES',
        ),
        persistence_pg_url: parseRequiredStringConfig(
            env.AUTH_PERSISTENCE_PG_URL,
            'AUTH_PERSISTENCE_PG_URL',
        ),
        persistence_snapshot_key: parseOptionalToken(
            env.AUTH_PERSISTENCE_SNAPSHOT_KEY,
        ) ?? DEFAULT_PERSISTENCE_SNAPSHOT_KEY,
    };
}

export interface ControlPlane {
    services: ControlPlaneServices;
    token_config: TokenServiceConfig;
    state_store: ControlPlaneStateStore;
    close: () => Promise<void>;
}

function buildControlPlane(
    stateStore: ControlPlaneStateStore,
    clock?: Clock,
    tokenConfig?: TokenServiceConfig,
): ControlPlane {
    const runtimeClock = clock ?? new SystemClock();
    const resolvedTokenConfig = tokenConfig ?? buildTokenServiceConfigFromEnv();
    const audit = new AuditService(runtimeClock, stateStore);
    const registry = new RegistryService(audit, runtimeClock, stateStore);
    const enrollment = new EnrollmentService(
        registry,
        audit,
        runtimeClock,
        stateStore,
    );
    const onboarding = new OnboardingService(
        audit,
        stateStore,
    );
    const rotation = new RotationService(registry, audit, runtimeClock);
    const token = new TokenService(
        registry,
        rotation,
        audit,
        runtimeClock,
        resolvedTokenConfig,
        stateStore,
    );

    return {
        services: {
            registry,
            enrollment,
            onboarding,
            rotation,
            token,
            audit,
        },
        token_config: resolvedTokenConfig,
        state_store: stateStore,
        close: async (): Promise<void> => {
            await stateStore.close?.();
        },
    };
}

export function createInMemoryControlPlane(
    clock?: Clock,
    tokenConfig?: TokenServiceConfig,
): ControlPlane {
    const stateStore = new InMemoryControlPlaneStateStore();

    return buildControlPlane(stateStore, clock, tokenConfig);
}

export async function createDurableControlPlane(
    persistencePgUrl: string,
    clock?: Clock,
    tokenConfig?: TokenServiceConfig,
    options?: {
        snapshot_key?: string;
    },
): Promise<ControlPlane> {
    const snapshotKey = options?.snapshot_key ??
        DEFAULT_PERSISTENCE_SNAPSHOT_KEY;
    const stateStore = await PostgresControlPlaneStateStore.connect(
        persistencePgUrl,
        snapshotKey,
    );

    return buildControlPlane(stateStore, clock, tokenConfig);
}

if (require.main === module) {
    void (async () => {
        const runtimeConfig = loadControlPlaneRuntimeConfig();
        const controlPlane = await createDurableControlPlane(
            runtimeConfig.persistence_pg_url,
            undefined,
            runtimeConfig.token_config,
            {
                snapshot_key: runtimeConfig.persistence_snapshot_key,
            },
        );
        const server = createControlPlaneServer(
            controlPlane.services,
            {
                adminApiEnabled: runtimeConfig.admin_api_enabled,
                adminToken: runtimeConfig.admin_token,
                internalApiEnabled: runtimeConfig.internal_api_enabled,
                internalToken: runtimeConfig.internal_token,
                maxJsonBodyBytes: runtimeConfig.max_json_body_bytes,
            },
        );
        const port = runtimeConfig.port;

        server.listen(port, () => {
            process.stdout.write(
                `rezilient-auth-control-plane listening on port ${port}\n`,
            );
        });
    })().catch((error: unknown) => {
        const message = error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);

        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}

export {
    AuditService,
    EnrollmentService,
    OnboardingService,
    RegistryService,
    RotationService,
    TokenService,
};
