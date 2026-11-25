import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
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
import { UuidInputGuard } from '../common/guards/uuid-input.guard.js';

/** Every signed-in role of an outlet may look at its floor (stewards and cashiers run it, the kitchen shows table numbers). */
const ANY_STAFF = [StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.CHEF, StaffRole.STEWARD, StaffRole.CASHIER];

@Controller('tables')
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  /**
   * Table list: signed-in staff of the outlet only (the diner journey never calls it: guests use /menu/public and /orders).
   * Tenant and outlet scoping is TenantGuard's: staff see their own outlet, an owner any outlet of the organisation.
   */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard, UuidInputGuard, TenantGuard)
  @Roles(...ANY_STAFF)
  async findAll(
    @Query('restaurantId') restaurantId?: string,
    @Query('restaurantSlug') restaurantSlug?: string,
  ) {
    const tables = await this.tablesService.findAll(restaurantId, restaurantSlug);
    return withMessage(tables, 'Tables retrieved successfully');
  }

  /** Single table details: signed-in staff of the table's outlet only. */
  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, UuidInputGuard, TenantGuard)
  @Roles(...ANY_STAFF)
  async findOne(@Param('id') id: string) {
    const table = await this.tablesService.findOne(id);
    return withMessage(table, 'Table details retrieved successfully');
  }

  /** Table status update: Allowed for Stewards, Cashiers, Chefs, Managers, Owners */
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard, UuidInputGuard, TenantGuard)
  @Roles(
    StaffRole.SUPER_OWNER,
    StaffRole.STORE_MANAGER,
    StaffRole.CHEF,
    StaffRole.STEWARD,
    StaffRole.CASHIER,
  )
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateTableStatusDto,
    @Req() req: any,
  ) {
    const updated = await this.tablesService.updateStatus(id, dto.status, req?.user?.restaurantId);
    return withMessage(updated, `Table status updated to ${dto.status}`);
  }

  /** Add table: Allowed for Owners and Managers */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async createTable(@Body() dto: CreateTableDto, @Req() req: any) {
    const created = await this.tablesService.create(dto, req?.user);
    return withMessage(created, `Table '${created.tableNumber}' added to floor successfully`);
  }

  /** Remove table: Allowed for Owners and Managers */
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, UuidInputGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async removeTable(@Param('id') id: string, @Req() req: any) {
    await this.tablesService.remove(id, req?.user?.restaurantId, req?.user);
    return withMessage({ id }, 'Table removed from floor successfully');
  }
}
