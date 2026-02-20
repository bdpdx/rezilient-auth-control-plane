import { createInMemoryControlPlane } from './index';
import { FixedClock } from './utils/clock';

export interface TestFixture {
    clock: FixedClock;
    control_plane: ReturnType<typeof createInMemoryControlPlane>;
}

export interface BootstrappedCredentials {
    tenant_id: string;
    instance_id: string;
    client_id: string;
    client_secret: string;
}

export function createFixture(): TestFixture {
    const clock = new FixedClock('2026-02-16T12:00:00.000Z');
    const controlPlane = createInMemoryControlPlane(clock, {
        issuer: 'rezilient-auth-control-plane-test',
        signing_key: 'test-signing-key-0123456789abcdef',
        token_ttl_seconds: 300,
        token_clock_skew_seconds: 30,
        outage_grace_window_seconds: 120,
    });

    return {
        clock,
        control_plane: controlPlane,
    };
}

export async function bootstrapRegistryAndCredentials(
    fixture: TestFixture,
    options?: {
        tenant_id?: string;
        tenant_name?: string;
        instance_id?: string;
        source?: string;
        allowed_services?: Array<'reg' | 'rrs'>;
    },
): Promise<BootstrappedCredentials> {
    const tenantId = options?.tenant_id ?? 'tenant-acme';
    const tenantName = options?.tenant_name ?? 'Acme';
    const instanceId = options?.instance_id ?? 'instance-dev-01';
    const source = options?.source ?? 'sn://acme-dev.service-now.com';
    const allowedServices = options?.allowed_services ?? ['reg', 'rrs'];

    await fixture.control_plane.services.registry.createTenant({
        tenant_id: tenantId,
        name: tenantName,
    });

    await fixture.control_plane.services.registry.createInstance({
        instance_id: instanceId,
        tenant_id: tenantId,
        source,
        allowed_services: allowedServices,
    });

    const enrollment = await fixture.control_plane.services.enrollment.issueEnrollmentCode({
        tenant_id: tenantId,
        instance_id: instanceId,
        ttl_seconds: 900,
    });
    const exchange = await fixture.control_plane.services.enrollment.exchangeEnrollmentCode(
        enrollment.enrollment_code,
    );

    if (!exchange.success) {
        throw new Error(`failed to bootstrap credentials: ${exchange.reason_code}`);
    }

    return {
        tenant_id: exchange.tenant_id,
        instance_id: exchange.instance_id,
        client_id: exchange.client_id,
        client_secret: exchange.client_secret,
    };
}
