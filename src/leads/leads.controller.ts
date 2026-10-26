import { Body, Controller, Post } from '@nestjs/common';
import { LeadsService } from './leads.service.js';
import { CreateLeadDto } from './dto/create-lead.dto.js';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Post()
  async createLead(@Body() dto: CreateLeadDto) {
    const lead = await this.leadsService.create(dto);
    return {
      message: 'Thank you! Our onboarding specialist will connect via WhatsApp within 4 hours.',
      lead,
    };
  }
}
