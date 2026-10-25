import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Restaurant } from './entities/restaurant.entity.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';

@Injectable()
export class RestaurantsService {
  constructor(
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
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
}
