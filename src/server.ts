import {
    createServer,
    IncomingMessage,
    Server,
    ServerResponse,
} from 'node:http';
import { URL } from 'node:url';
import { ServiceScope } from './constants';
import { AuditService } from './audit/audit.service';
import { EnrollmentService } from './enrollment/enrollment.service';
import { RegistryService } from './registry/registry.service';
import { InstanceRecord, TenantRecord } from './registry/types';
import { RotationService } from './rotation/rotation.service';
import { TokenService } from './token/token.service';

export interface ControlPlaneServices {
    registry: RegistryService;
    enrollment: EnrollmentService;
    rotation: RotationService;
    token: TokenService;
    audit: AuditService;
}

export interface ControlPlaneServerOptions {
    adminToken?: string;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
        return {};
    }

    const body = Buffer.concat(chunks).toString('utf8');

    if (!body.trim()) {
        return {};
    }

    const parsed = JSON.parse(body) as unknown;

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('request body must be an object');
    }

    return parsed as Record<string, unknown>;
}

function sendJson(
    response: ServerResponse,
    statusCode: number,
    payload: Record<string, unknown>,
): void {
    response.statusCode = statusCode;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
}

function asString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty string`);
    }

    return value;
}

function asOptionalString(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('optional string field must be non-empty when provided');
    }

    return value;
}

function asNumber(value: unknown, fieldName: string): number {
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
        throw new Error(`${fieldName} must be a valid number`);
    }

    return value;
}

function asStringArray(value: unknown, fieldName: string): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty string array`);
    }

    const result: string[] = [];

    for (const item of value) {
        if (typeof item !== 'string' || item.length === 0) {
            throw new Error(`${fieldName} contains invalid value`);
        }

        result.push(item);
    }

    return result;
}

function isAdminRequest(pathname: string): boolean {
    return pathname.startsWith('/v1/admin/');
}

function isAdminAuthorized(
    request: IncomingMessage,
    options?: ControlPlaneServerOptions,
): boolean {
    if (!options?.adminToken) {
        return true;
    }

    return request.headers['x-rezilient-admin-token'] === options.adminToken;
}

function summarizeTenants(tenants: TenantRecord[]): Record<string, number> {
    let active = 0;
    let suspended = 0;
    let disabled = 0;
    let entitledActive = 0;
    let entitledSuspended = 0;
    let entitledDisabled = 0;

    for (const tenant of tenants) {
        if (tenant.state === 'active') {
            active += 1;
        } else if (tenant.state === 'suspended') {
            suspended += 1;
        } else if (tenant.state === 'disabled') {
            disabled += 1;
        }

        if (tenant.entitlement_state === 'active') {
            entitledActive += 1;
        } else if (tenant.entitlement_state === 'suspended') {
            entitledSuspended += 1;
        } else if (tenant.entitlement_state === 'disabled') {
            entitledDisabled += 1;
        }
    }

    return {
        total: tenants.length,
        active,
        suspended,
        disabled,
        entitlement_active: entitledActive,
        entitlement_suspended: entitledSuspended,
        entitlement_disabled: entitledDisabled,
    };
}

function summarizeInstances(instances: InstanceRecord[]): Record<string, number> {
    let active = 0;
    let suspended = 0;
    let disabled = 0;

    for (const instance of instances) {
        if (instance.state === 'active') {
            active += 1;
        } else if (instance.state === 'suspended') {
            suspended += 1;
        } else if (instance.state === 'disabled') {
            disabled += 1;
        }
    }

    return {
        total: instances.length,
        active,
        suspended,
        disabled,
    };
}

function buildInstanceAdminRecord(instance: InstanceRecord): Record<string, unknown> {
    const credentials = instance.client_credentials;

    if (!credentials) {
        return {
            ...instance,
            enrollment_state: 'not_enrolled',
            rotation_state: 'not_enrolled',
            secret_summary: {
                total_versions: 0,
                revoked_versions: 0,
                adopted_versions: 0,
            },
        };
    }

    const nextVersion = credentials.next_secret_version_id
        ? credentials.secret_versions.find((secret) =>
            secret.version_id === credentials.next_secret_version_id
        )
        : undefined;
    const revokedVersions = credentials.secret_versions.filter((secret) =>
        Boolean(secret.revoked_at)
    ).length;
    const adoptedVersions = credentials.secret_versions.filter((secret) =>
        Boolean(secret.adopted_at)
    ).length;
    const nextAdopted = Boolean(nextVersion?.adopted_at);
    const rotationState = credentials.next_secret_version_id
        ? nextAdopted
            ? 'adopted_pending_promotion'
            : 'rotation_in_progress'
        : 'stable';

    return {
        ...instance,
        enrollment_state: 'enrolled',
        rotation_state: rotationState,
        secret_summary: {
            total_versions: credentials.secret_versions.length,
            revoked_versions: revokedVersions,
            adopted_versions: adoptedVersions,
            current_secret_version_id: credentials.current_secret_version_id,
            next_secret_version_id: credentials.next_secret_version_id,
        },
    };
}

function buildOverviewPayload(services: ControlPlaneServices): Record<string, unknown> {
    const tenants = services.registry.listTenants();
    const instances = services.registry.listInstances();
    const events = services.audit.list();

    let enrollmentCodesIssued = 0;
    let enrollmentCodesExchanged = 0;
    let enrollmentExchangeDenied = 0;
    let outageDeniedTotal = 0;
    let outageRefreshDeniedTotal = 0;
    let outageModeToggleTotal = 0;
    let rotationsInProgress = 0;
    let adoptedPendingPromotion = 0;
    let revokedSecretEvents = 0;

    for (const event of events) {
        if (event.event_type === 'enrollment_code_issued') {
            enrollmentCodesIssued += 1;
        }

        if (event.event_type === 'enrollment_code_exchanged') {
            enrollmentCodesExchanged += 1;
        }

        if (
            event.event_type === 'token_mint_denied' &&
            event.metadata?.phase === 'enrollment_exchange'
        ) {
            enrollmentExchangeDenied += 1;
        }

        if (
            event.event_type === 'token_mint_denied' &&
            event.deny_reason_code === 'denied_auth_control_plane_outage'
        ) {
            outageDeniedTotal += 1;

            if (event.metadata?.flow === 'refresh') {
                outageRefreshDeniedTotal += 1;
            }
        }

        if (event.event_type === 'control_plane_outage_mode_changed') {
            outageModeToggleTotal += 1;
        }

        if (event.event_type === 'secret_revoked') {
            revokedSecretEvents += 1;
        }
    }

    for (const instance of instances) {
        const credentials = instance.client_credentials;

        if (!credentials?.next_secret_version_id) {
            continue;
        }

        rotationsInProgress += 1;

        const nextSecret = credentials.secret_versions.find((secret) =>
            secret.version_id === credentials.next_secret_version_id
        );

        if (nextSecret?.adopted_at) {
            adoptedPendingPromotion += 1;
        }
    }

    return {
        outage_active: services.token.isOutageModeActive(),
        degraded_mode_counters: {
            token_mint_denied_outage_total: outageDeniedTotal,
            token_refresh_denied_outage_total: outageRefreshDeniedTotal,
            outage_mode_toggle_total: outageModeToggleTotal,
        },
        enrollment: {
            codes_issued_total: enrollmentCodesIssued,
            codes_exchanged_total: enrollmentCodesExchanged,
            exchange_denied_total: enrollmentExchangeDenied,
        },
        rotation: {
            in_progress_total: rotationsInProgress,
            adopted_pending_promotion_total: adoptedPendingPromotion,
            revoked_secret_events_total: revokedSecretEvents,
        },
        tenants: summarizeTenants(tenants),
        instances: summarizeInstances(instances),
    };
}

export function createControlPlaneServer(
    services: ControlPlaneServices,
    options?: ControlPlaneServerOptions,
): Server {
    return createServer(async (request, response) => {
        try {
            const method = request.method || 'GET';
            const parsedUrl = new URL(request.url || '/', 'http://localhost');
            const pathname = parsedUrl.pathname;

            if (isAdminRequest(pathname) && !isAdminAuthorized(request, options)) {
                sendJson(response, 403, {
                    error: 'forbidden',
                    reason_code: 'admin_auth_required',
                });

                return;
            }

            if (method === 'GET' && pathname === '/v1/health') {
                sendJson(response, 200, {
                    ok: true,
                    outage_active: services.token.isOutageModeActive(),
                });

                return;
            }

            if (method === 'GET' && pathname === '/v1/admin/audit-events') {
                const limitParam = parsedUrl.searchParams.get('limit');
                const limit = limitParam ? Number(limitParam) : undefined;
                const events = services.audit.list(limit);

                sendJson(response, 200, {
                    events,
                });

                return;
            }

            if (method === 'GET' && pathname === '/v1/admin/tenants') {
                sendJson(response, 200, {
                    tenants: services.registry.listTenants(),
                });

                return;
            }

            if (method === 'GET' && pathname === '/v1/admin/instances') {
                const instances = services.registry.listInstances();

                sendJson(response, 200, {
                    instances: instances.map((instance) =>
                        buildInstanceAdminRecord(instance)
                    ),
                });

                return;
            }

            const instanceGetMatch = pathname.match(
                /^\/v1\/admin\/instances\/([^/]+)$/,
            );

            if (method === 'GET' && instanceGetMatch) {
                const instanceId = decodeURIComponent(instanceGetMatch[1]);
                const instance = services.registry.getInstance(instanceId);

                if (!instance) {
                    sendJson(response, 404, {
                        error: 'not_found',
                    });

                    return;
                }

                sendJson(response, 200, {
                    instance: buildInstanceAdminRecord(instance),
                });

                return;
            }

            if (method === 'GET' && pathname === '/v1/admin/degraded-mode') {
                const overview = buildOverviewPayload(services);

                sendJson(response, 200, {
                    outage_active: overview.outage_active,
                    degraded_mode_counters: overview.degraded_mode_counters,
                });

                return;
            }

            if (method === 'GET' && pathname === '/v1/admin/overview') {
                sendJson(response, 200, buildOverviewPayload(services));

                return;
            }

            if (method !== 'POST') {
                sendJson(response, 404, {
                    error: 'not_found',
                });

                return;
            }

            const body = await readJsonBody(request);

            if (pathname === '/v1/admin/tenants') {
                const tenant = services.registry.createTenant({
                    tenant_id: asString(body.tenant_id, 'tenant_id'),
                    name: asString(body.name, 'name'),
                    state: body.state as never,
                    entitlement_state: body.entitlement_state as never,
                    actor: asOptionalString(body.actor),
                });

                sendJson(response, 201, {
                    tenant,
                });

                return;
            }

            if (pathname === '/v1/admin/instances') {
                const allowedServices = body.allowed_services
                    ? asStringArray(body.allowed_services, 'allowed_services')
                    : undefined;
                const instance = services.registry.createInstance({
                    instance_id: asString(body.instance_id, 'instance_id'),
                    tenant_id: asString(body.tenant_id, 'tenant_id'),
                    source: asString(body.source, 'source'),
                    state: body.state as never,
                    allowed_services: allowedServices as ServiceScope[] | undefined,
                    actor: asOptionalString(body.actor),
                });

                sendJson(response, 201, {
                    instance,
                });

                return;
            }

            if (pathname === '/v1/admin/enrollment-codes') {
                const result = services.enrollment.issueEnrollmentCode({
                    tenant_id: asString(body.tenant_id, 'tenant_id'),
                    instance_id: asString(body.instance_id, 'instance_id'),
                    requested_by: asOptionalString(body.requested_by),
                    ttl_seconds: body.ttl_seconds
                        ? asNumber(body.ttl_seconds, 'ttl_seconds')
                        : 900,
                });

                sendJson(response, 201, result as unknown as Record<string, unknown>);

                return;
            }

            if (pathname === '/v1/auth/enroll/exchange') {
                const result = services.enrollment.exchangeEnrollmentCode(
                    asString(body.enrollment_code, 'enrollment_code'),
                );

                sendJson(response, result.success ? 200 : 401, result as unknown as Record<string, unknown>);

                return;
            }

            if (pathname === '/v1/auth/token') {
                const result = services.token.mintToken({
                    grant_type: asOptionalString(body.grant_type),
                    flow: body.flow as 'mint' | 'refresh' | undefined,
                    client_id: asString(body.client_id, 'client_id'),
                    client_secret: asString(body.client_secret, 'client_secret'),
                    service_scope: asString(body.service_scope, 'service_scope'),
                });

                sendJson(response, result.success ? 200 : 401, result as unknown as Record<string, unknown>);

                return;
            }

            if (pathname === '/v1/auth/token/validate') {
                const expectedScope = body.expected_service_scope
                    ? asString(body.expected_service_scope, 'expected_service_scope')
                    : undefined;
                const result = services.token.validateToken({
                    access_token: asString(body.access_token, 'access_token'),
                    expected_service_scope: expectedScope as ServiceScope | undefined,
                });

                sendJson(response, result.success ? 200 : 401, result as unknown as Record<string, unknown>);

                return;
            }

            if (pathname === '/v1/admin/degraded-mode') {
                const outageActive = Boolean(body.outage_active);

                services.token.setOutageMode(
                    outageActive,
                    asOptionalString(body.actor),
                );

                sendJson(response, 200, {
                    outage_active: services.token.isOutageModeActive(),
                });

                return;
            }

            const rotateMatch = pathname.match(/^\/v1\/admin\/instances\/([^/]+)\/rotate-secret$/);

            if (rotateMatch) {
                const instanceId = decodeURIComponent(rotateMatch[1]);
                const result = services.rotation.startRotation({
                    instance_id: instanceId,
                    requested_by: asOptionalString(body.requested_by),
                    overlap_seconds: body.overlap_seconds
                        ? asNumber(body.overlap_seconds, 'overlap_seconds')
                        : 86400,
                });

                sendJson(response, 200, result as unknown as Record<string, unknown>);

                return;
            }

            const completeMatch = pathname.match(/^\/v1\/admin\/instances\/([^/]+)\/complete-rotation$/);

            if (completeMatch) {
                const instanceId = decodeURIComponent(completeMatch[1]);
                const result = services.rotation.completeRotation({
                    instance_id: instanceId,
                    requested_by: asOptionalString(body.requested_by),
                });

                sendJson(response, 200, result as unknown as Record<string, unknown>);

                return;
            }

            const revokeMatch = pathname.match(/^\/v1\/admin\/instances\/([^/]+)\/revoke-secret$/);

            if (revokeMatch) {
                const instanceId = decodeURIComponent(revokeMatch[1]);

                services.rotation.revokeSecret({
                    instance_id: instanceId,
                    secret_version_id: asString(
                        body.secret_version_id,
                        'secret_version_id',
                    ),
                    requested_by: asOptionalString(body.requested_by),
                    reason: asOptionalString(body.reason),
                });

                sendJson(response, 200, {
                    ok: true,
                });

                return;
            }

            const stateMatch = pathname.match(/^\/v1\/admin\/instances\/([^/]+)\/state$/);

            if (stateMatch) {
                const instanceId = decodeURIComponent(stateMatch[1]);
                const instance = services.registry.setInstanceState(
                    instanceId,
                    asString(body.state, 'state') as never,
                    asOptionalString(body.actor),
                );

                sendJson(response, 200, {
                    instance,
                });

                return;
            }

            const servicesMatch = pathname.match(/^\/v1\/admin\/instances\/([^/]+)\/services$/);

            if (servicesMatch) {
                const instanceId = decodeURIComponent(servicesMatch[1]);
                const allowedServices = asStringArray(
                    body.allowed_services,
                    'allowed_services',
                );
                const instance = services.registry.setInstanceAllowedServices(
                    instanceId,
                    allowedServices as ServiceScope[],
                    asOptionalString(body.actor),
                );

                sendJson(response, 200, {
                    instance,
                });

                return;
            }

            const tenantStateMatch = pathname.match(/^\/v1\/admin\/tenants\/([^/]+)\/state$/);

            if (tenantStateMatch) {
                const tenantId = decodeURIComponent(tenantStateMatch[1]);
                const tenant = services.registry.setTenantState(
                    tenantId,
                    asString(body.state, 'state') as never,
                    asOptionalString(body.actor),
                );

                sendJson(response, 200, {
                    tenant,
                });

                return;
            }

            const tenantEntitlementMatch = pathname.match(
                /^\/v1\/admin\/tenants\/([^/]+)\/entitlement-state$/,
            );

            if (tenantEntitlementMatch) {
                const tenantId = decodeURIComponent(tenantEntitlementMatch[1]);
                const tenant = services.registry.setTenantEntitlement(
                    tenantId,
                    asString(body.entitlement_state, 'entitlement_state') as never,
                    asOptionalString(body.actor),
                );

                sendJson(response, 200, {
                    tenant,
                });

                return;
            }

            sendJson(response, 404, {
                error: 'not_found',
            });
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : 'unknown_error';

            sendJson(response, 400, {
                error: 'bad_request',
                message,
            });
        }
    });
}
