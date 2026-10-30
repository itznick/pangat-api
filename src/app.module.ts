import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller.js';
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

@Module({
  imports: [
    // Global environment configuration
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // Rate limiting: 120 requests / 60 seconds per IP
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 120,
      },
    ]),

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
        const isNeonOrCloud =
          isProd ||
          dbUrl.includes('neon.tech') ||
          dbUrl.includes('sslmode=require');

        return {
          type: 'postgres',
          url: dbUrl,
          autoLoadEntities: true,
          synchronize: true, // Auto-sync database schema on Neon
          ssl: isNeonOrCloud
            ? { rejectUnauthorized: false }
            : false,
          retryAttempts: 10,
          retryDelay: 3000,
          extra: {
            ssl: isNeonOrCloud
              ? { rejectUnauthorized: false }
              : false,
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
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
