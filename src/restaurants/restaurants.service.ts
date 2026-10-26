import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Restaurant } from './entities/restaurant.entity.js';
import { Staff } from '../auth/entities/staff.entity.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';

@Injectable()
export class RestaurantsService {
  constructor(
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    @InjectRepository(Staff)
    private readonly staffRepo: Repository<Staff>,
  ) {}

  async findBySlug(slug: string): Promise<Restaurant> {
    const restaurant = await this.restaurantRepo.findOne({
      where: { slug },
      relations: { tables: true },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant with slug '${slug}' not found`);
    }

    return restaurant;
  }

  async updateSettings(slug: string, dto: UpdateSettingsDto): Promise<Restaurant> {
    const restaurant = await this.findBySlug(slug);

    Object.assign(restaurant, dto);
    return this.restaurantRepo.save(restaurant);
  }

  async createStaff(restaurantId: string, dto: CreateStaffDto) {
    const restaurant = await this.restaurantRepo.findOne({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant with ID '${restaurantId}' not found`);
    }

    const existing = await this.staffRepo.findOne({
      where: { email: dto.email },
    });

    if (existing) {
      throw new BadRequestException('A user with this email address already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password || 'pangat123', 10);
    const staff = this.staffRepo.create({
      name: dto.name,
      email: dto.email,
      passwordHash,
      role: dto.role,
      organizationId: restaurant.organizationId,
      restaurantId: restaurant.id,
      pinCode: dto.pinCode || null,
    });

    const saved = await this.staffRepo.save(staff);
    const { passwordHash: _, ...cleanStaff } = saved;
    return cleanStaff;
  }
}
