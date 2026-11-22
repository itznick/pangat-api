import { Global, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailDeliveryService } from '../common/services/email-delivery.service.js';
import { PasswordLinkService } from '../common/services/password-link.service.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { PlatformSettingsService } from './settings.service.js';
import { PlatformAuditService } from './audit.service.js';
import { PlatformEventsService } from './events.service.js';
import { SubscriptionsAdminService } from './subscriptions-admin.service.js';
import { RestaurantsAdminService } from './restaurants-admin.service.js';
import { FinanceService } from './finance.service.js';
import { DashboardService } from './dashboard.service.js';
import { UsersAdminService } from './users-admin.service.js';
import { CommsService } from './comms.service.js';
import { SupportService } from './support.service.js';
import { ExportsService } from './exports.service.js';
import { ErrorLogService, MetricsService, MonitoringService, RequestMetricsMiddleware } from './monitoring.service.js';
import { JobsService } from './jobs.service.js';
import { PlatformController, PlatformPublicController } from './platform.controller.js';
import { PlatformAdminGuard } from './guards.js';
import { Staff } from '../auth/entities/staff.entity.js';

/** Platform control centre: settings, audit, events, monitoring and every Super Admin service. Global so any module can audit / read settings. */
@Global()
@Module({
  imports: [SubscriptionsModule, TypeOrmModule.forFeature([Staff])],
  controllers: [PlatformController, PlatformPublicController],
  providers: [
    EmailDeliveryService, PasswordLinkService, PlatformAdminGuard, PlatformSettingsService, PlatformAuditService, PlatformEventsService, SubscriptionsAdminService, RestaurantsAdminService,
    FinanceService, DashboardService, UsersAdminService, CommsService, SupportService, ExportsService, MetricsService, MonitoringService, ErrorLogService, JobsService,
  ],
  exports: [PlatformSettingsService, PlatformAuditService, PlatformEventsService, EmailDeliveryService, PasswordLinkService, MetricsService, CommsService, PlatformAdminGuard],
})
export class PlatformModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestMetricsMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
