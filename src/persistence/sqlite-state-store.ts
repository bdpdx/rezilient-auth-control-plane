import { DatabaseSync } from 'node:sqlite';
import { ControlPlaneStateStore } from './state-store';
import {
    cloneControlPlaneState,
    ControlPlaneState,
    createEmptyControlPlaneState,
} from './types';

interface SnapshotRow {
    version: number;
    state_json: string;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS acp_state_snapshots (
    snapshot_id INTEGER PRIMARY KEY CHECK (snapshot_id = 1),
    version INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
`;

const SELECT_SNAPSHOT_SQL = `
SELECT version, state_json
FROM acp_state_snapshots
WHERE snapshot_id = 1
`;

const INSERT_SNAPSHOT_SQL = `
INSERT INTO acp_state_snapshots (
    snapshot_id,
    version,
    state_json,
    updated_at
) VALUES (
    1,
    ?,
    ?,
    ?
)
`;

const UPDATE_SNAPSHOT_SQL = `
UPDATE acp_state_snapshots
SET version = ?, state_json = ?, updated_at = ?
WHERE snapshot_id = 1
`;

function serializeState(state: ControlPlaneState): string {
    return JSON.stringify(state);
}

function parseState(stateJson: string): ControlPlaneState {
    const parsed = JSON.parse(stateJson) as unknown;

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

    if (state.code_hash_to_id && typeof state.code_hash_to_id === 'object') {
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

export class SqliteControlPlaneStateStore implements ControlPlaneStateStore {
    private readonly database: DatabaseSync;

    constructor(private readonly dbPath: string) {
        this.database = new DatabaseSync(dbPath);
        this.database.exec('PRAGMA journal_mode = WAL');
        this.database.exec('PRAGMA synchronous = NORMAL');
        this.database.exec(CREATE_TABLE_SQL);
        this.ensureSnapshotRow();
    }

    read(): ControlPlaneState {
        const row = this.selectSnapshot();

        if (!row) {
            return createEmptyControlPlaneState();
        }

        return parseState(row.state_json);
    }

    mutate<T>(mutator: (state: ControlPlaneState) => T): T {
        this.database.exec('BEGIN IMMEDIATE');

        try {
            const row = this.selectSnapshotForTransaction();
            const currentState = row
                ? parseState(row.state_json)
                : createEmptyControlPlaneState();
            const result = mutator(currentState);
            const nextVersion = (row?.version ?? 0) + 1;
            const updatedAt = new Date().toISOString();
            const stateJson = serializeState(currentState);
            const updateStatement = this.database.prepare(UPDATE_SNAPSHOT_SQL);

            updateStatement.run(nextVersion, stateJson, updatedAt);
            this.database.exec('COMMIT');

            return result;
        } catch (error) {
            this.database.exec('ROLLBACK');
            throw error;
        }
    }

    private ensureSnapshotRow(): void {
        const row = this.selectSnapshot();

        if (row) {
            return;
        }

        const initialState = createEmptyControlPlaneState();
        const insertStatement = this.database.prepare(INSERT_SNAPSHOT_SQL);

        insertStatement.run(
            0,
            serializeState(initialState),
            new Date().toISOString(),
        );
    }

    private selectSnapshot(): SnapshotRow | undefined {
        const statement = this.database.prepare(SELECT_SNAPSHOT_SQL);

        return statement.get() as SnapshotRow | undefined;
    }

    private selectSnapshotForTransaction(): SnapshotRow | undefined {
        const statement = this.database.prepare(SELECT_SNAPSHOT_SQL);
        const row = statement.get() as SnapshotRow | undefined;

        if (row) {
            return row;
        }

        const insertStatement = this.database.prepare(INSERT_SNAPSHOT_SQL);
        const emptyState = createEmptyControlPlaneState();

        insertStatement.run(
            0,
            serializeState(emptyState),
            new Date().toISOString(),
        );

        return {
            version: 0,
            state_json: serializeState(emptyState),
        };
    }
}
