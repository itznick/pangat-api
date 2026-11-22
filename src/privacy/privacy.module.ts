import { Module } from '@nestjs/common';
import { PrivacyService } from './privacy.service.js';
import { PrivacyAdminController, PrivacyPublicController } from './privacy.controller.js';

/** Data-principal rights: intake, officer workflow, lookup, erasure and the retention sweep. PlatformModule (global) supplies audit + email. */
@Module({
  controllers: [PrivacyPublicController, PrivacyAdminController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
