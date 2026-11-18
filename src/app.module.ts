import { Logger, Module } from '@nestjs/common';
import { resolveDbSsl } from './common/security/db-ssl.js';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { ReportsModule } from './reports/reports.module.js';
import { MigrationRunner } from './common/migrations/migration-runner.service.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { RestaurantsModule } from './restaurants/restaurants.module.js';
import { TablesModule } from './tables/tables.module.js';
import { MenuModule } from './menu/menu.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { EventsModule } from './events/events.module.js';
import { LeadsModule } from './leads/leads.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AuditModule } from './audit/audit.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [
    // Global environment configuration
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // Rate limiting: 120 requests / 60 seconds per IP
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 120,
        },
      ],
      // Only for automated test runs against a throwaway database; never set in production
      skipIf: () => process.env.THROTTLE_DISABLED === 'true',
    }),

    // PostgreSQL connection via Neon
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProd = process.env.NODE_ENV === 'production';
        const dbUrl =
          config.get<string>('DATABASE_URL') ||
          process.env.DATABASE_URL ||
          '';
        const { ssl, warning } = resolveDbSsl({
          NODE_ENV: process.env.NODE_ENV,
          DATABASE_URL: dbUrl,
          DATABASE_CA: process.env.DATABASE_CA,
          DATABASE_SSL_REJECT_UNAUTHORIZED: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
        });
        if (warning) new Logger('Database').warn(warning);

        return {
          type: 'postgres',
          url: dbUrl,
          autoLoadEntities: true,
          synchronize: !isProd, // Disabled in production: the numbered SQL files in src/migrations are the schema
          ssl,
          retryAttempts: 10,
          retryDelay: 3000,
          extra: {
            ssl,
            max: 15,
            connectionTimeoutMillis: 10000,
            idleTimeoutMillis: 30000,
          },
        };
      },
    }),

    // Application domain modules
    AuthModule,
    OrganizationsModule,
    RestaurantsModule,
    TablesModule,
    MenuModule,
    OrdersModule,
    EventsModule,
    LeadsModule,
    AdminModule,
    AuditModule,
    InventoryModule,
    SubscriptionsModule,
    PlatformModule,
    ReportsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    MigrationRunner,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
