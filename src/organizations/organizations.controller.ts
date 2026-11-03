import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  Query,
} from '@nestjs/common';
import { OrganizationsService } from './organizations.service.js';
import { CreateOutletDto } from './dto/create-outlet.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('organizations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrganizationsController {
  constructor(private readonly orgService: OrganizationsService) {}

  @Get('outlets')
  async listOutlets(@Req() req: any, @Query('orgId') orgId?: string) {
    const outlets = await this.orgService.listOutlets(req.user, orgId);
    return withMessage(outlets, 'Organization outlets retrieved successfully');
  }

  @Post('outlets')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.PLATFORM_SUPER_ADMIN)
  async createOutlet(@Req() req: any, @Body() dto: CreateOutletDto) {
    const outlet = await this.orgService.createOutlet(req.user, dto);
    return withMessage(
      outlet,
      'New outlet branch and floor batch provisioned successfully',
    );
  }
}
