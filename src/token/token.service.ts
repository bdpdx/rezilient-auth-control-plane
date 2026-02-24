import {
    AuthDenyReasonCode,
    InFlightReasonCode,
    ServiceScope,
    isServiceScope,
} from '../constants';
import { AuditService } from '../audit/audit.service';
import { InMemoryControlPlaneStateStore } from '../persistence/in-memory-state-store';
import { ControlPlaneStateStore } from '../persistence/state-store';
import { RegistryService } from '../registry/registry.service';
import {
    ClientCredentialsRecord,
    InstanceRecord,
    TenantRecord,
} from '../registry/types';
import { RotationService } from '../rotation/rotation.service';
import { Clock } from '../utils/clock';
import {
    randomToken,
    safeEqualHex,
    sha256Hex,
    signJwt,
    verifyJwt,
} from '../utils/crypto';

export interface TokenServiceConfig {
    issuer: string;
    signing_key: string;
    token_ttl_seconds: number;
    token_clock_skew_seconds: number;
    outage_grace_window_seconds: number;
}

export interface TokenMintRequest {
    grant_type?: string;
    flow?: 'mint' | 'refresh';
    client_id: string;
    client_secret: string;
    service_scope: string;
}

export interface TokenMintSuccess {
    success: true;
    token_type: 'bearer';
    access_token: string;
    expires_in: number;
    scope: ServiceScope;
    issued_at: string;
    expires_at: string;
    tenant_id: string;
    instance_id: string;
    source: string;
}

export interface TokenMintFailure {
    success: false;
    reason_code: AuthDenyReasonCode;
}

export type TokenMintResult = TokenMintSuccess | TokenMintFailure;

export interface TokenValidateRequest {
    access_token: string;
    expected_service_scope?: ServiceScope;
}

export interface TokenClaims {
    iss: string;
    sub: string;
    aud: string;
    jti: string;
    iat: number;
    exp: number;
    service_scope: ServiceScope;
    tenant_id: string;
    instance_id: string;
    source: string;
}

export interface TokenValidateSuccess {
    success: true;
    claims: TokenClaims;
}

export interface TokenValidateFailure {
    success: false;
    reason_code: AuthDenyReasonCode;
}

export type TokenValidateResult = TokenValidateSuccess | TokenValidateFailure;

export interface RefreshDecision {
    action: 'refresh_allowed' | 'retry_within_grace' | 'pause_in_flight';
    reason_code: InFlightReasonCode;
}

export interface InFlightEntitlementDecision {
    action: 'continue' | 'continue_until_chunk_boundary' | 'pause';
    reason_code: InFlightReasonCode;
}

interface MatchedSecret {
    version_id: string;
    is_next_version: boolean;
}

function parseNumericClaim(payload: Record<string, unknown>, key: string): number {
    const value = payload[key];

    if (typeof value !== 'number') {
        throw new Error(`token claim ${key} is not numeric`);
    }

    return value;
}

function parseStringClaim(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];

    if (typeof value !== 'string') {
        throw new Error(`token claim ${key} is not string`);
    }

    return value;
}

function isSecretActive(secret: {
    revoked_at?: string;
    valid_until?: string;
}, nowIso: string): boolean {
    if (secret.revoked_at) {
        return false;
    }

    if (secret.valid_until && nowIso > secret.valid_until) {
        return false;
    }

    return true;
}

export class TokenService {
    constructor(
        private readonly registry: RegistryService,
        private readonly rotation: RotationService,
        private readonly audit: AuditService,
        private readonly clock: Clock,
        private readonly config: TokenServiceConfig,
        private readonly stateStore: ControlPlaneStateStore =
            new InMemoryControlPlaneStateStore(),
    ) {}

    async setOutageMode(active: boolean, actor?: string): Promise<void> {
        await this.stateStore.mutate((state) => {
            state.outage_active = active;
        });

        await this.audit.record({
            event_type: 'control_plane_outage_mode_changed',
            actor,
            metadata: {
                outage_active: await this.isOutageModeActive(),
            },
        });
    }

    async isOutageModeActive(): Promise<boolean> {
        return (await this.stateStore.read()).outage_active;
    }

    async mintToken(request: TokenMintRequest): Promise<TokenMintResult> {
        if (
            request.grant_type !== undefined &&
            request.grant_type !== 'client_credentials'
        ) {
            return await this.denyMint(request, 'denied_invalid_grant');
        }

        if (!isServiceScope(request.service_scope)) {
            return await this.denyMint(request, 'denied_service_not_allowed');
        }

        if (await this.isOutageModeActive()) {
            return await this.denyMint(
                request,
                'denied_auth_control_plane_outage',
            );
        }

        const instance = await this.registry.getInstanceByClientId(
            request.client_id,
        );

        if (!instance || !instance.client_credentials) {
            return await this.denyMint(request, 'denied_invalid_client');
        }

        const tenant = await this.registry.getTenant(instance.tenant_id);

        if (!tenant) {
            return await this.denyMint(
                request,
                'denied_invalid_client',
                instance,
            );
        }

        const tenantEligibility = this.evaluateTenantEligibility(tenant);

        if (tenantEligibility !== 'none') {
            return await this.denyMint(request, tenantEligibility, instance);
        }

        const instanceEligibility = this.evaluateInstanceEligibility(instance);

        if (instanceEligibility !== 'none') {
            return await this.denyMint(request, instanceEligibility, instance);
        }

        if (!instance.allowed_services.includes(request.service_scope)) {
            return await this.denyMint(
                request,
                'denied_service_not_allowed',
                instance,
            );
        }

        const matchedSecret = this.matchSecret(
            instance.client_credentials,
            request.client_secret,
        );

        if (!matchedSecret) {
            return await this.denyMint(
                request,
                'denied_invalid_secret',
                instance,
            );
        }

        const now = this.clock.now();
        const issuedAt = now.toISOString();
        const iat = Math.floor(now.getTime() / 1000);
        const exp = iat + this.config.token_ttl_seconds;
        const expiresAt = new Date(exp * 1000).toISOString();
        const claims: TokenClaims = {
            iss: this.config.issuer,
            sub: request.client_id,
            aud: `rezilient:${request.service_scope}`,
            jti: `tok_${randomToken(12)}`,
            iat,
            exp,
            service_scope: request.service_scope,
            tenant_id: tenant.tenant_id,
            instance_id: instance.instance_id,
            source: instance.source,
        };
        const accessToken = signJwt(
            claims as unknown as Record<string, unknown>,
            this.config.signing_key,
        );

        if (matchedSecret.is_next_version) {
            await this.rotation.recordAdoption(
                instance.instance_id,
                matchedSecret.version_id,
            );
        }

        const flow = request.flow ?? 'mint';
        const successEventType = flow === 'refresh'
            ? 'token_refreshed'
            : 'token_minted';

        await this.audit.record({
            event_type: successEventType,
            tenant_id: tenant.tenant_id,
            instance_id: instance.instance_id,
            client_id: request.client_id,
            service_scope: request.service_scope,
            metadata: {
                flow,
                secret_version_id: matchedSecret.version_id,
                expires_at: expiresAt,
            },
        });

        return {
            success: true,
            token_type: 'bearer',
            access_token: accessToken,
            expires_in: this.config.token_ttl_seconds,
            scope: request.service_scope,
            issued_at: issuedAt,
            expires_at: expiresAt,
            tenant_id: tenant.tenant_id,
            instance_id: instance.instance_id,
            source: instance.source,
        };
    }

    async validateToken(
        request: TokenValidateRequest,
    ): Promise<TokenValidateResult> {
        const verified = verifyJwt(
            request.access_token,
            this.config.signing_key,
        );

        if (!verified.valid) {
            const reason = verified.reason === 'malformed'
                ? 'denied_token_malformed'
                : 'denied_token_invalid_signature';

            await this.audit.record({
                event_type: 'token_validate_denied',
                deny_reason_code: reason,
                metadata: {
                    expected_service_scope: request.expected_service_scope,
                },
            });

            return {
                success: false,
                reason_code: reason,
            };
        }

        try {
            const payload = verified.payload as Record<string, unknown>;
            const claims: TokenClaims = {
                iss: parseStringClaim(payload, 'iss'),
                sub: parseStringClaim(payload, 'sub'),
                aud: parseStringClaim(payload, 'aud'),
                jti: parseStringClaim(payload, 'jti'),
                iat: parseNumericClaim(payload, 'iat'),
                exp: parseNumericClaim(payload, 'exp'),
                service_scope: parseStringClaim(
                    payload,
                    'service_scope',
                ) as ServiceScope,
                tenant_id: parseStringClaim(payload, 'tenant_id'),
                instance_id: parseStringClaim(payload, 'instance_id'),
                source: parseStringClaim(payload, 'source'),
            };

            if (!isServiceScope(claims.service_scope)) {
                return {
                    success: false,
                    reason_code: 'denied_token_malformed',
                };
            }

            if (claims.iss !== this.config.issuer) {
                await this.audit.record({
                    event_type: 'token_validate_denied',
                    deny_reason_code: 'denied_token_malformed',
                    tenant_id: claims.tenant_id,
                    instance_id: claims.instance_id,
                    client_id: claims.sub,
                    service_scope: claims.service_scope,
                    metadata: {
                        expected_issuer: this.config.issuer,
                    },
                });

                return {
                    success: false,
                    reason_code: 'denied_token_malformed',
                };
            }

            const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);

            if (nowSeconds > (claims.exp + this.config.token_clock_skew_seconds)) {
                await this.audit.record({
                    event_type: 'token_validate_denied',
                    deny_reason_code: 'denied_token_expired',
                    tenant_id: claims.tenant_id,
                    instance_id: claims.instance_id,
                    client_id: claims.sub,
                    service_scope: claims.service_scope,
                    metadata: {
                        exp: claims.exp,
                    },
                });

                return {
                    success: false,
                    reason_code: 'denied_token_expired',
                };
            }

            if (
                request.expected_service_scope &&
                claims.service_scope !== request.expected_service_scope
            ) {
                await this.audit.record({
                    event_type: 'token_validate_denied',
                    deny_reason_code: 'denied_token_wrong_service_scope',
                    tenant_id: claims.tenant_id,
                    instance_id: claims.instance_id,
                    client_id: claims.sub,
                    service_scope: claims.service_scope,
                    metadata: {
                        expected_service_scope: request.expected_service_scope,
                    },
                });

                return {
                    success: false,
                    reason_code: 'denied_token_wrong_service_scope',
                };
            }

            await this.audit.record({
                event_type: 'token_validated',
                tenant_id: claims.tenant_id,
                instance_id: claims.instance_id,
                client_id: claims.sub,
                service_scope: claims.service_scope,
                metadata: {
                    expected_service_scope: request.expected_service_scope,
                },
            });

            return {
                success: true,
                claims,
            };
        } catch {
            return {
                success: false,
                reason_code: 'denied_token_malformed',
            };
        }
    }

    async evaluateRefreshDuringOutage(
        tokenExpiresAtIso: string,
    ): Promise<RefreshDecision> {
        if (!(await this.isOutageModeActive())) {
            return {
                action: 'refresh_allowed',
                reason_code: 'none',
            };
        }

        const nowMs = this.clock.now().getTime();
        const expiryMs = new Date(tokenExpiresAtIso).getTime();
        const graceMs = this.config.outage_grace_window_seconds * 1000;

        if (nowMs <= (expiryMs + graceMs)) {
            return {
                action: 'retry_within_grace',
                reason_code: 'blocked_auth_control_plane_outage',
            };
        }

        return {
            action: 'pause_in_flight',
            reason_code: 'paused_token_refresh_grace_exhausted',
        };
    }

    async evaluateInFlightEntitlement(
        instanceId: string,
        atChunkBoundary: boolean,
    ): Promise<InFlightEntitlementDecision> {
        const instance = await this.registry.getInstance(instanceId);

        if (!instance) {
            return {
                action: atChunkBoundary ? 'pause' : 'continue_until_chunk_boundary',
                reason_code: 'paused_instance_disabled',
            };
        }

        const tenant = await this.registry.getTenant(instance.tenant_id);

        if (!tenant || tenant.state !== 'active' || tenant.entitlement_state !== 'active') {
            return {
                action: atChunkBoundary ? 'pause' : 'continue_until_chunk_boundary',
                reason_code: 'paused_entitlement_disabled',
            };
        }

        if (instance.state !== 'active') {
            return {
                action: atChunkBoundary ? 'pause' : 'continue_until_chunk_boundary',
                reason_code: 'paused_instance_disabled',
            };
        }

        return {
            action: 'continue',
            reason_code: 'none',
        };
    }

    private evaluateTenantEligibility(
        tenant: TenantRecord,
    ): AuthDenyReasonCode {
        if (tenant.state === 'suspended') {
            return 'denied_tenant_suspended';
        }

        if (tenant.state === 'disabled') {
            return 'denied_tenant_disabled';
        }

        if (tenant.entitlement_state === 'suspended') {
            return 'denied_tenant_not_entitled';
        }

        if (tenant.entitlement_state === 'disabled') {
            return 'denied_tenant_not_entitled';
        }

        return 'none';
    }

    private evaluateInstanceEligibility(
        instance: InstanceRecord,
    ): AuthDenyReasonCode {
        if (instance.state === 'suspended') {
            return 'denied_instance_suspended';
        }

        if (instance.state === 'disabled') {
            return 'denied_instance_disabled';
        }

        return 'none';
    }

    private matchSecret(
        credentials: ClientCredentialsRecord,
        suppliedSecret: string,
    ): MatchedSecret | undefined {
        const nowIso = this.clock.now().toISOString();
        const suppliedHash = sha256Hex(suppliedSecret);

        for (const secret of credentials.secret_versions) {
            if (!isSecretActive(secret, nowIso)) {
                continue;
            }

            if (!safeEqualHex(secret.secret_hash, suppliedHash)) {
                continue;
            }

            return {
                version_id: secret.version_id,
                is_next_version:
                    credentials.next_secret_version_id === secret.version_id,
            };
        }

        return undefined;
    }

    private async denyMint(
        request: TokenMintRequest,
        reasonCode: AuthDenyReasonCode,
        instance?: InstanceRecord,
    ): Promise<TokenMintFailure> {
        await this.audit.record({
            event_type: 'token_mint_denied',
            deny_reason_code: reasonCode,
            tenant_id: instance?.tenant_id,
            instance_id: instance?.instance_id,
            client_id: request.client_id,
            service_scope: isServiceScope(request.service_scope)
                ? request.service_scope
                : undefined,
            metadata: {
                service_scope: request.service_scope,
                grant_type: request.grant_type,
                flow: request.flow ?? 'mint',
            },
        });

        return {
            success: false,
            reason_code: reasonCode,
        };
    }
}
