import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { PlatformAdminGuard } from './guards/platform-admin.guard.js';

@Module({
  controllers: [AdminController],
  providers: [AdminService, PlatformAdminGuard],
  exports: [AdminService],
})
export class AdminModule {}
