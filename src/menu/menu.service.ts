import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MenuItem } from './entities/menu-item.entity.js';
import { MenuCategory } from './entities/menu-category.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { CreateItemDto, UpdateItemDto } from './dto/create-item.dto.js';

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

  async createItem(dto: CreateItemDto) {
    const slug = dto.restaurantSlug || 'pangat';
    const restaurant = await this.restaurantRepo.findOne({ where: { slug } });
    if (!restaurant) {
      throw new NotFoundException(`Restaurant '${slug}' not found`);
    }

    const item = this.menuItemRepo.create({
      name: dto.name,
      description: dto.description || '',
      price: dto.price,
      categoryId: dto.categoryId,
      restaurantId: restaurant.id,
      isVeg: dto.isVeg ?? true,
      imageUrl: dto.imageUrl || '🍽️',
      isAvailable: true,
      isPopular: false,
    });

    return this.menuItemRepo.save(item);
  }

  async updateItem(id: string, dto: UpdateItemDto) {
    const item = await this.menuItemRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Menu item '${id}' not found`);
    }

    if (dto.name !== undefined) item.name = dto.name;
    if (dto.description !== undefined) item.description = dto.description;
    if (dto.price !== undefined) item.price = dto.price;
    if (dto.categoryId !== undefined) item.categoryId = dto.categoryId;
    if (dto.isVeg !== undefined) item.isVeg = dto.isVeg;
    if (dto.imageUrl !== undefined) item.imageUrl = dto.imageUrl;
    if (dto.isAvailable !== undefined) item.isAvailable = dto.isAvailable;

    return this.menuItemRepo.save(item);
  }
}
