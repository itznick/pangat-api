import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Lead } from './entities/lead.entity.js';
import { CreateLeadDto } from './dto/create-lead.dto.js';
import { UpdateLeadDto } from './dto/update-lead.dto.js';

@Injectable()
export class LeadsService {
  constructor(
    @InjectRepository(Lead)
    private readonly leadRepo: Repository<Lead>,
  ) {}

  async create(createLeadDto: CreateLeadDto): Promise<Lead> {
    const lead = this.leadRepo.create({
      name: createLeadDto.name,
      restaurantName: createLeadDto.restaurantName,
      phone: createLeadDto.phone,
      city: createLeadDto.city,
      tableCount: createLeadDto.tableCount || '10-20',
      notes: createLeadDto.notes || null,
    });
    return this.leadRepo.save(lead);
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
