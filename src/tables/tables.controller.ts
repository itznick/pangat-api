import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TablesService } from './tables.service.js';
import { UpdateTableStatusDto } from './dto/update-table-status.dto.js';
import { CreateTableDto } from './dto/create-table.dto.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';

@Controller('tables')
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  /** Table list: Open to diner lookup and staff */
  @Get()
  async findAll(
    @Query('restaurantId') restaurantId?: string,
    @Query('restaurantSlug') restaurantSlug?: string,
  ) {
    const tables = await this.tablesService.findAll(restaurantId, restaurantSlug);
    return withMessage(tables, 'Tables retrieved successfully');
  }

  /** Single table details: Open to diner & staff */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const table = await this.tablesService.findOne(id);
    return withMessage(table, 'Table details retrieved successfully');
  }

  /** Table status update: Allowed for Stewards, Cashiers, Chefs, Managers, Owners */
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(
    StaffRole.SUPER_OWNER,
    StaffRole.STORE_MANAGER,
    StaffRole.CHEF,
    StaffRole.STEWARD,
  )
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateTableStatusDto,
  ) {
    const updated = await this.tablesService.updateStatus(id, dto.status);
    return withMessage(updated, `Table status updated to ${dto.status}`);
  }

  /** Add table: Allowed for Owners and Managers */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async createTable(@Body() dto: CreateTableDto) {
    const created = await this.tablesService.create(dto);
    return withMessage(created, `Table '${created.tableNumber}' added to floor successfully`);
  }

  /** Remove table: Allowed for Owners and Managers */
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async removeTable(@Param('id') id: string) {
    await this.tablesService.remove(id);
    return withMessage({ id }, 'Table removed from floor successfully');
  }
}
