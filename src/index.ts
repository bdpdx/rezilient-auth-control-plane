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

function parseIntConfig(
    value: string | undefined,
    defaultValue: number,
    keyName: string,
): number {
    if (!value) {
        return defaultValue;
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${keyName} must be a positive number`);
    }

    return parsed;
}

export interface InMemoryControlPlane {
    services: ControlPlaneServices;
    token_config: TokenServiceConfig;
}

export function createInMemoryControlPlane(clock?: Clock): InMemoryControlPlane {
    const runtimeClock = clock ?? new SystemClock();
    const tokenConfig: TokenServiceConfig = {
        issuer: process.env.AUTH_ISSUER || 'rezilient-auth-control-plane',
        signing_key: process.env.AUTH_SIGNING_KEY || 'dev-only-signing-key-change-me',
        token_ttl_seconds: parseIntConfig(
            process.env.TOKEN_TTL_SECONDS,
            300,
            'TOKEN_TTL_SECONDS',
        ),
        token_clock_skew_seconds: parseIntConfig(
            process.env.TOKEN_CLOCK_SKEW_SECONDS,
            30,
            'TOKEN_CLOCK_SKEW_SECONDS',
        ),
        outage_grace_window_seconds: parseIntConfig(
            process.env.OUTAGE_GRACE_WINDOW_SECONDS,
            120,
            'OUTAGE_GRACE_WINDOW_SECONDS',
        ),
    };
    const audit = new AuditService(runtimeClock);
    const registry = new RegistryService(audit, runtimeClock);
    const enrollment = new EnrollmentService(registry, audit, runtimeClock);
    const rotation = new RotationService(registry, audit, runtimeClock);
    const token = new TokenService(
        registry,
        rotation,
        audit,
        runtimeClock,
        tokenConfig,
    );

    return {
        services: {
            registry,
            enrollment,
            rotation,
            token,
            audit,
        },
        token_config: tokenConfig,
    };
}

if (require.main === module) {
    const controlPlane = createInMemoryControlPlane();
    const server = createControlPlaneServer(controlPlane.services, {
        adminToken: process.env.AUTH_ADMIN_TOKEN,
    });
    const port = parseIntConfig(process.env.PORT, 3010, 'PORT');

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
