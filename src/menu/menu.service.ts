import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MenuItem } from './entities/menu-item.entity.js';
import { MenuCategory } from './entities/menu-category.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';

@Injectable()
export class MenuService {
  constructor(
    @InjectRepository(MenuItem)
    private readonly menuItemRepo: Repository<MenuItem>,
    @InjectRepository(MenuCategory)
    private readonly categoryRepo: Repository<MenuCategory>,
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
  ) {}

  async getPublicMenu(restaurantSlug: string) {
    const restaurant = await this.restaurantRepo.findOne({
      where: { slug: restaurantSlug },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant '${restaurantSlug}' not found`);
    }

    const categories = await this.categoryRepo.find({
      where: { restaurantId: restaurant.id },
      order: { sortOrder: 'ASC' },
    });

    const items = await this.menuItemRepo.find({
      where: { restaurantId: restaurant.id },
      relations: { modifiers: true, category: true },
      order: { name: 'ASC' },
    });

    return {
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        upiVpa: restaurant.upiVpa,
        gstPercentage: Number(restaurant.gstPercentage),
        isVegOnly: restaurant.isVegOnly,
      },
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sortOrder,
      })),
      items: items.map((i) => ({
        id: i.id,
        categoryId: i.categoryId,
        name: i.name,
        description: i.description,
        price: Number(i.price),
        isVeg: i.isVeg,
        isAvailable: i.isAvailable,
        imageUrl: i.imageUrl,
        isPopular: i.isPopular,
        modifiers: (i.modifiers || []).map((m) => ({
          id: m.id,
          name: m.name,
          type: m.type,
          isRequired: m.isRequired,
          options: m.options,
        })),
      })),
    };
  }

  async getAllItems(restaurantId?: string) {
    const where = restaurantId ? { restaurantId } : {};
    return this.menuItemRepo.find({
      where,
      relations: { category: true, modifiers: true },
      order: { name: 'ASC' },
    });
  }

  async updateAvailability(id: string, isAvailable: boolean) {
    const item = await this.menuItemRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Menu item '${id}' not found`);
    }
    item.isAvailable = isAvailable;
    return this.menuItemRepo.save(item);
  }

  async updatePrice(id: string, price: number) {
    const item = await this.menuItemRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Menu item '${id}' not found`);
    }
    item.price = price;
    return this.menuItemRepo.save(item);
  }
}
