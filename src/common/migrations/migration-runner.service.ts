import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/** Migrations 001-008 predate this runner and were applied by hand; only later ones are auto-applied. */
const FIRST_AUTO_MIGRATION = 9;

/**
 * Applies the numbered SQL files in /migrations that have not run yet (production runs with
 * `synchronize: false`, so the schema must be brought forward explicitly).
 *
 *  - every file is idempotent (IF NOT EXISTS / guarded DO blocks) and additive,
 *  - each file runs in its own transaction, so a failure leaves the database exactly as it was,
 *  - a Postgres advisory lock stops two instances from migrating at once,
 *  - progress is recorded in `schema_migrations`,
 *  - set AUTO_MIGRATE=false to opt out and run the files manually.
 */
@Injectable()
export class MigrationRunner implements OnModuleInit {
  private readonly logger = new Logger(MigrationRunner.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    if (process.env.AUTO_MIGRATE === 'false') {
      this.logger.warn('AUTO_MIGRATE=false: skipping automatic schema migrations');
      return;
    }
    const dir = [join(__dirname, '../../migrations'), join(process.cwd(), 'src/migrations')].find(existsSync);
    if (!dir) {
      this.logger.warn('Migrations folder not found; skipping');
      return;
    }
    const files = readdirSync(dir)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f) && !f.endsWith('.down.sql'))
      .filter((f) => Number(f.slice(0, 3)) >= FIRST_AUTO_MIGRATION)
      .sort();
    if (files.length === 0) return;

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query('SELECT pg_advisory_lock(727001)');
      await runner.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const done = new Set<string>((await runner.query('SELECT name FROM schema_migrations')).map((r: any) => r.name));
      for (const file of files) {
        if (done.has(file)) continue;
        this.logger.log(`Applying migration ${file}`);
        await runner.startTransaction();
        try {
          await runner.query(readFileSync(join(dir, file), 'utf8'));
          await runner.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await runner.commitTransaction();
        } catch (err) {
          await runner.rollbackTransaction();
          this.logger.error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
          throw err; // refuse to start on a half-migrated schema
        }
      }
    } finally {
      await runner.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
      await runner.release();
    }
  }
}
