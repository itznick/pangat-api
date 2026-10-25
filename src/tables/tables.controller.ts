import { Controller, Get, Patch, Param, Body, Query } from '@nestjs/common';
import { TablesService } from './tables.service.js';
import { UpdateTableStatusDto } from './dto/update-table-status.dto.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('tables')
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  @Get()
  async findAll(@Query('restaurantId') restaurantId?: string) {
    const tables = await this.tablesService.findAll(restaurantId);
    return withMessage(tables, 'Tables retrieved successfully');
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const table = await this.tablesService.findOne(id);
    return withMessage(table, 'Table details retrieved successfully');
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateTableStatusDto,
  ) {
    const updated = await this.tablesService.updateStatus(id, dto.status);
    return withMessage(updated, `Table status updated to ${dto.status}`);
  }
}
