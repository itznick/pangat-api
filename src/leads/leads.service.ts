import { Injectable, Optional } from '@nestjs/common';
import { PlatformEventsService } from '../platform/events.service.js';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PRIVACY_POLICY_VERSION } from '../platform/compliance.js';
import { Lead } from './entities/lead.entity.js';
import { CreateLeadDto } from './dto/create-lead.dto.js';
import { UpdateLeadDto } from './dto/update-lead.dto.js';

@Injectable()
export class LeadsService {
  constructor(
    @InjectRepository(Lead)
    private readonly leadRepo: Repository<Lead>,
    @Optional() private readonly events?: PlatformEventsService,
  ) {}

  async create(createLeadDto: CreateLeadDto): Promise<Lead> {
    const lead = this.leadRepo.create({
      name: createLeadDto.name,
      restaurantName: createLeadDto.restaurantName,
      phone: createLeadDto.phone,
      city: createLeadDto.city,
      tableCount: createLeadDto.tableCount || '10-20',
      notes: createLeadDto.notes || null,
      consentVersion: PRIVACY_POLICY_VERSION,
      consentAt: new Date(),
    });
    const saved = await this.leadRepo.save(lead);
    // Tell the operators a new lead is waiting (stored in the bell; emailed when alerts are on). A failure here must never lose or delay the lead.
    await this.events
      ?.emit('NEW_LEAD', 'INFO', `New lead: ${saved.restaurantName || saved.name}`, `${saved.name}, ${saved.restaurantName || 'restaurant'}${saved.city ? `, ${saved.city}` : ''}. Phone ${saved.phone}. Open Super Admin > Leads.`, { entityType: 'lead', entityId: saved.id })
      .catch(() => undefined);
    return saved;
  }

  async findAll(): Promise<Lead[]> {
    return this.leadRepo.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Lead | null> {
    return this.leadRepo.findOne({ where: { id } });
  }

  async update(id: string, updateLeadDto: UpdateLeadDto): Promise<Lead> {
    const lead = await this.leadRepo.findOneOrFail({ where: { id } });
    if (updateLeadDto.status !== undefined) {
      lead.status = updateLeadDto.status;
    }
    if (updateLeadDto.notes !== undefined) {
      lead.notes = updateLeadDto.notes;
    }
    return this.leadRepo.save(lead);
  }
}
