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
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly orgService: OrganizationsService) {}

  @Get('outlets')
  async listOutlets(@Req() req: any, @Query('orgId') orgId?: string) {
    const outlets = await this.orgService.listOutlets(req.user, orgId);
    return withMessage(outlets, 'Organization outlets retrieved successfully');
  }

  @Post('outlets')
  async createOutlet(@Req() req: any, @Body() dto: CreateOutletDto) {
    const outlet = await this.orgService.createOutlet(req.user, dto);
    return withMessage(
      outlet,
      'New outlet branch and floor batch provisioned successfully',
    );
  }
}
