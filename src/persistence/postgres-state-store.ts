import { Pool } from 'pg';
import { ControlPlaneStateStore } from './state-store';
import {
    cloneControlPlaneState,
    ControlPlaneState,
    createEmptyControlPlaneState,
} from './types';

interface SnapshotRow {
    version: number;
    state_json: unknown;
}

const DEFAULT_SNAPSHOT_KEY = 'default';

const CHECK_SNAPSHOT_TABLE_SQL = `
SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'acp_state_snapshots'
) AS exists
`;

const SELECT_SNAPSHOT_SQL = `
SELECT version, state_json
FROM acp_state_snapshots
WHERE snapshot_key = $1
`;

const SELECT_SNAPSHOT_FOR_UPDATE_SQL = `
SELECT version, state_json
FROM acp_state_snapshots
WHERE snapshot_key = $1
FOR UPDATE
`;

const INSERT_SNAPSHOT_SQL = `
INSERT INTO acp_state_snapshots (
    snapshot_key,
    version,
    state_json,
    updated_at
) VALUES (
    $1,
    $2,
    $3::jsonb,
    NOW()
)
`;

const UPSERT_SNAPSHOT_SQL = `
INSERT INTO acp_state_snapshots (
    snapshot_key,
    version,
    state_json,
    updated_at
) VALUES (
    $1,
    0,
    $2::jsonb,
    NOW()
)
ON CONFLICT (snapshot_key) DO NOTHING
`;

const UPDATE_SNAPSHOT_SQL = `
UPDATE acp_state_snapshots
SET version = $1,
    state_json = $2::jsonb,
    updated_at = NOW()
WHERE snapshot_key = $3
`;

function serializeState(state: ControlPlaneState): string {
    return JSON.stringify(state);
}

function parseState(statePayload: unknown): ControlPlaneState {
    let parsed: unknown = statePayload;

    if (typeof statePayload === 'string') {
        parsed = JSON.parse(statePayload) as unknown;
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('invalid persisted state payload');
    }

    const state = parsed as Partial<ControlPlaneState>;
    let tenants: ControlPlaneState['tenants'] = {};
    let instances: ControlPlaneState['instances'] = {};
    let clientIdToInstance: ControlPlaneState['client_id_to_instance'] = {};
    let enrollmentRecords: ControlPlaneState['enrollment_records'] = {};
    let codeHashToId: ControlPlaneState['code_hash_to_id'] = {};

    if (state.tenants && typeof state.tenants === 'object') {
        tenants = state.tenants as ControlPlaneState['tenants'];
    }

    if (state.instances && typeof state.instances === 'object') {
        instances = state.instances as ControlPlaneState['instances'];
    }

    if (
        state.client_id_to_instance &&
        typeof state.client_id_to_instance === 'object'
    ) {
        clientIdToInstance = state.client_id_to_instance as
            ControlPlaneState['client_id_to_instance'];
    }

    if (
        state.enrollment_records &&
        typeof state.enrollment_records === 'object'
    ) {
        enrollmentRecords = state.enrollment_records as
            ControlPlaneState['enrollment_records'];
    }

    if (
        state.code_hash_to_id &&
        typeof state.code_hash_to_id === 'object'
    ) {
        codeHashToId = state.code_hash_to_id as
            ControlPlaneState['code_hash_to_id'];
    }

    return cloneControlPlaneState({
        tenants,
        instances,
        client_id_to_instance: clientIdToInstance,
        enrollment_records: enrollmentRecords,
        code_hash_to_id: codeHashToId,
        audit_events: Array.isArray(state.audit_events)
            ? state.audit_events
            : [],
        cross_service_audit_events: Array.isArray(
            state.cross_service_audit_events,
        )
            ? state.cross_service_audit_events
            : [],
        outage_active: typeof state.outage_active === 'boolean'
            ? state.outage_active
            : false,
    });
}

export class PostgresControlPlaneStateStore implements ControlPlaneStateStore {
    private constructor(
        private readonly pool: Pool,
        private readonly snapshotKey: string,
    ) {}

    static async connect(
        connectionString: string,
        snapshotKey: string = DEFAULT_SNAPSHOT_KEY,
    ): Promise<PostgresControlPlaneStateStore> {
        const pool = new Pool({
            connectionString,
            max: 5,
            allowExitOnIdle: true,
        });
        const store = new PostgresControlPlaneStateStore(
            pool,
            snapshotKey,
        );

        await store.ensureBootstrapReady();

        return store;
    }

    async read(): Promise<ControlPlaneState> {
        const result = await this.pool.query<SnapshotRow>(
            SELECT_SNAPSHOT_SQL,
            [this.snapshotKey],
        );

        if (result.rowCount === 0 || result.rows.length === 0) {
            return createEmptyControlPlaneState();
        }

        return parseState(result.rows[0].state_json);
    }

    async mutate<T>(
        mutator: (state: ControlPlaneState) => T | Promise<T>,
    ): Promise<T> {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');
            let row = await client.query<SnapshotRow>(
                SELECT_SNAPSHOT_FOR_UPDATE_SQL,
                [this.snapshotKey],
            );

            if (row.rowCount === 0 || row.rows.length === 0) {
                const emptyState = createEmptyControlPlaneState();

                await client.query(
                    INSERT_SNAPSHOT_SQL,
                    [this.snapshotKey, 0, serializeState(emptyState)],
                );
                row = await client.query<SnapshotRow>(
                    SELECT_SNAPSHOT_FOR_UPDATE_SQL,
                    [this.snapshotKey],
                );
            }

            if (row.rowCount === 0 || row.rows.length === 0) {
                throw new Error('failed to initialize persisted state row');
            }

            const currentVersion = Number(row.rows[0].version);
            const currentState = parseState(row.rows[0].state_json);
            const result = await mutator(currentState);

            await client.query(
                UPDATE_SNAPSHOT_SQL,
                [
                    currentVersion + 1,
                    serializeState(currentState),
                    this.snapshotKey,
                ],
            );
            await client.query('COMMIT');

            return result;
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // Preserve original failure when rollback cannot run.
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    private async ensureBootstrapReady(): Promise<void> {
        const tableCheck = await this.pool.query<{ exists: boolean }>(
            CHECK_SNAPSHOT_TABLE_SQL,
        );
        const exists = tableCheck.rows[0]?.exists === true;

        if (!exists) {
            throw new Error(
                'ACP persistence schema is not initialized. ' +
                'Run `npm run migrate:persistence` with AUTH_PERSISTENCE_PG_URL ' +
                'before starting ACP.',
            );
        }

        await this.pool.query(
            UPSERT_SNAPSHOT_SQL,
            [
                this.snapshotKey,
                serializeState(createEmptyControlPlaneState()),
            ],
        );
    }
}
