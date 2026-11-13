import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Self-heals databases where migration 008 was never applied (production runs with
 * `synchronize: false`). Idempotent and mirrors 008_outlet_operations.sql.
 */
@Injectable()
export class OperationsColumnBootstrap implements OnModuleInit {
  private readonly logger = new Logger(OperationsColumnBootstrap.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.dataSource.query(
        'ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS operations jsonb',
      );
    } catch (err) {
      this.logger.error(
        `Could not ensure restaurants.operations column: ${(err as Error).message}`,
      );
    }
  }
}
