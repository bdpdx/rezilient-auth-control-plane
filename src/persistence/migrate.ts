import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, PoolClient } from 'pg';

const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '../../db/migrations');
const DEFAULT_ADVISORY_LOCK_ID = 638154201;

const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS acp_schema_migrations (
    migration_id TEXT PRIMARY KEY,
    checksum_sha256 TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

const LIST_MIGRATIONS_SQL = `
SELECT migration_id, checksum_sha256
FROM acp_schema_migrations
ORDER BY migration_id ASC
`;

const INSERT_MIGRATION_SQL = `
INSERT INTO acp_schema_migrations (
    migration_id,
    checksum_sha256,
    applied_at
) VALUES (
    $1,
    $2,
    NOW()
)
`;

interface AppliedMigrationRow {
    migration_id: string;
    checksum_sha256: string;
}

interface MigrationFile {
    migration_id: string;
    filename: string;
    sql: string;
    checksum_sha256: string;
}

export interface RunMigrationsResult {
    applied_count: number;
    skipped_count: number;
}

function extractMigrationId(filename: string): string {
    if (!filename.endsWith('.sql')) {
        throw new Error(`migration is not a .sql file: ${filename}`);
    }

    const migrationId = filename.slice(0, -4);

    if (!/^[0-9]{4}_[a-z0-9_]+$/.test(migrationId)) {
        throw new Error(
            `migration filename must match 0001_description.sql: ${filename}`,
        );
    }

    return migrationId;
}

function computeSha256(input: string): string {
    return createHash('sha256')
        .update(input, 'utf8')
        .digest('hex');
}

async function loadMigrationFiles(
    migrationsDir: string,
): Promise<MigrationFile[]> {
    const entries = await readdir(migrationsDir, {
        withFileTypes: true,
    });
    const sqlFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

    if (sqlFiles.length === 0) {
        throw new Error(`no SQL migration files found in ${migrationsDir}`);
    }

    const migrations: MigrationFile[] = [];

    for (const filename of sqlFiles) {
        const migration_id = extractMigrationId(filename);
        const sqlPath = resolve(migrationsDir, filename);
        const sql = await readFile(sqlPath, 'utf8');
        const normalizedSql = sql.trim();

        if (normalizedSql.length === 0) {
            throw new Error(`migration file is empty: ${filename}`);
        }

        migrations.push({
            migration_id,
            filename,
            sql: normalizedSql,
            checksum_sha256: computeSha256(normalizedSql),
        });
    }

    return migrations;
}

async function withTransaction<T>(
    client: PoolClient,
    operation: () => Promise<T>,
): Promise<T> {
    await client.query('BEGIN');

    try {
        const result = await operation();

        await client.query('COMMIT');

        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the original migration error.
        }
        throw error;
    }
}

export async function runPostgresPersistenceMigrations(
    connectionString: string,
    options?: {
        migrations_dir?: string;
        advisory_lock_id?: number;
    },
): Promise<RunMigrationsResult> {
    const migrationsDir = options?.migrations_dir ?? DEFAULT_MIGRATIONS_DIR;
    const advisoryLockId = options?.advisory_lock_id ??
        DEFAULT_ADVISORY_LOCK_ID;
    const migrations = await loadMigrationFiles(migrationsDir);
    const pool = new Pool({
        connectionString,
        max: 1,
        allowExitOnIdle: true,
    });
    const client = await pool.connect();
    let applied_count = 0;
    let skipped_count = 0;

    try {
        await client.query(CREATE_MIGRATIONS_TABLE_SQL);
        await client.query('SELECT pg_advisory_lock($1)', [advisoryLockId]);

        const appliedResult = await client.query<AppliedMigrationRow>(
            LIST_MIGRATIONS_SQL,
        );
        const appliedById = new Map<string, string>();

        for (const row of appliedResult.rows) {
            appliedById.set(row.migration_id, row.checksum_sha256);
        }

        for (const migration of migrations) {
            const appliedChecksum = appliedById.get(migration.migration_id);

            if (appliedChecksum) {
                if (appliedChecksum !== migration.checksum_sha256) {
                    throw new Error(
                        `checksum mismatch for already-applied migration ` +
                        `${migration.filename}`,
                    );
                }

                skipped_count += 1;
                continue;
            }

            await withTransaction(client, async () => {
                await client.query(migration.sql);
                await client.query(
                    INSERT_MIGRATION_SQL,
                    [
                        migration.migration_id,
                        migration.checksum_sha256,
                    ],
                );
            });
            applied_count += 1;
        }
    } finally {
        try {
            await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockId]);
        } catch {
            // Connection may already be closed; nothing actionable here.
        }
        client.release();
        await pool.end();
    }

    return {
        applied_count,
        skipped_count,
    };
}

async function runFromEnv(): Promise<void> {
    const connectionString = process.env.AUTH_PERSISTENCE_PG_URL;

    if (!connectionString || connectionString.trim().length === 0) {
        throw new Error('AUTH_PERSISTENCE_PG_URL is required');
    }

    const result = await runPostgresPersistenceMigrations(connectionString);

    process.stdout.write(
        `ACP persistence migrations complete: ` +
        `applied=${result.applied_count} ` +
        `skipped=${result.skipped_count}\n`,
    );
}

if (require.main === module) {
    void runFromEnv().catch((error: unknown) => {
        const message = error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);

        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
