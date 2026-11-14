import { AuditService } from '../audit/audit.service.js';
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { getOrderingStatus, resolveOperations } from '../restaurants/operations.js';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MenuItem } from './entities/menu-item.entity.js';
import { MenuCategory } from './entities/menu-category.entity.js';
import { Modifier } from './entities/modifier.entity.js';
import { ModifierType } from '../common/enums/index.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { CreateItemDto, UpdateItemDto } from './dto/create-item.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';

@Injectable()
export class MenuService {
  constructor(
    @InjectRepository(MenuItem)
    private readonly menuItemRepo: Repository<MenuItem>,
    @InjectRepository(MenuCategory)
    private readonly categoryRepo: Repository<MenuCategory>,
    @InjectRepository(Modifier)
    private readonly modifierRepo: Repository<Modifier>,
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    private readonly auditService: AuditService,
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
        operations: resolveOperations(restaurant.operations),
        ordering: getOrderingStatus(restaurant.operations),
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
    if (!restaurantId) {
      // Never list every tenant's menu: callers must say which outlet they mean
      throw new BadRequestException('restaurantId is required');
    }
    return this.menuItemRepo.find({
      where: { restaurantId },
      relations: { category: true, modifiers: true },
      order: { name: 'ASC' },
    });
  }

  async updateAvailability(id: string, isAvailable: boolean, authorizedRestaurantId?: string) {
    const item = await this.menuItemRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Menu item '${id}' not found`);
    }
    if (authorizedRestaurantId && item.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Menu item does not belong to authorized restaurant');
    }
    item.isAvailable = isAvailable;
    item.autoDisabled = false; // a manual choice always wins over the automatic one
    return this.menuItemRepo.save(item);
  }

  async updatePrice(id: string, price: number, authorizedRestaurantId?: string, actor?: any) {
    const item = await this.menuItemRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Menu item '${id}' not found`);
    }
    if (authorizedRestaurantId && item.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Menu item does not belong to authorized restaurant');
    }
    const previous = Number(item.price);
    item.price = price;
    const saved = await this.menuItemRepo.save(item);
    await this.audit(item.restaurantId, 'MENU_ITEM', item.id, 'PRICE_CHANGED', actor, { name: item.name, from: previous, to: price });
    return saved;
  }

  private async audit(restaurantId: string, entityType: string, entityId: string, action: string, actor: any, metadata: Record<string, any>) {
    try {
      await this.auditService.record({
        restaurantId, entityType, entityId, action,
        staffId: actor?.id, staffName: actor?.name, staffRole: actor?.role, metadata,
      });
    } catch {
      /* auditing must never block menu edits */
    }
  }

  /** The category must exist and belong to the same outlet as the dish (no cross-tenant attachment). */
  private async assertCategory(categoryId: string, restaurantId: string) {
    const category = await this.categoryRepo.findOne({ where: { id: categoryId } });
    if (!category || category.restaurantId !== restaurantId) {
      throw new BadRequestException('Choose a category from this outlet');
    }
  }

  /** Soft delete: the dish disappears from menus but past orders and recipes keep their history. */
  async removeItem(id: string, authorizedRestaurantId: string | undefined, actor?: any) {
    const item = await this.menuItemRepo.findOne({ where: { id } });
    if (!item) throw new NotFoundException(`Menu item '${id}' not found`);
    if (authorizedRestaurantId && item.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Menu item does not belong to authorized restaurant');
    }
    await this.menuItemRepo.softRemove(item);
    await this.audit(item.restaurantId, 'MENU_ITEM', item.id, 'ITEM_DELETED', actor, { name: item.name });
  }

  async updateCategory(id: string, dto: { name?: string; sortOrder?: number }, authorizedRestaurantId?: string) {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) throw new NotFoundException(`Category '${id}' not found`);
    if (authorizedRestaurantId && category.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Category does not belong to authorized restaurant');
    }
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Category name cannot be empty');
      category.name = name;
    }
    if (dto.sortOrder !== undefined) category.sortOrder = dto.sortOrder;
    return this.categoryRepo.save(category);
  }

  async createCategory(dto: CreateCategoryDto) {
    let restaurant: Restaurant | null = null;
    if (dto.restaurantId) {
      restaurant = await this.restaurantRepo.findOne({ where: { id: dto.restaurantId } });
    } else if (dto.restaurantSlug) {
      restaurant = await this.restaurantRepo.findOne({ where: { slug: dto.restaurantSlug } });
    }

    if (!restaurant) {
      throw new NotFoundException('Restaurant not found for category');
    }

    const category = this.categoryRepo.create({
      name: dto.name.trim(),
      restaurantId: restaurant.id,
      sortOrder: dto.sortOrder ?? 0,
    });

    return this.categoryRepo.save(category);
  }

  async removeCategory(id: string, authorizedRestaurantId?: string) {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(`Category '${id}' not found`);
    }
    if (authorizedRestaurantId && category.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Category does not belong to authorized restaurant');
    }

    const existingItemsCount = await this.menuItemRepo.count({ where: { categoryId: id } });
    if (existingItemsCount > 0) {
      throw new BadRequestException(
        `Cannot delete category '${category.name}' because it contains ${existingItemsCount} menu dish(es). Reassign or remove items first.`,
      );
    }

    await this.categoryRepo.remove(category);
  }

  async createItem(dto: CreateItemDto) {
    let restaurant: Restaurant | null = null;
    if (dto.restaurantId) {
      restaurant = await this.restaurantRepo.findOne({ where: { id: dto.restaurantId } });
    } else if (dto.restaurantSlug) {
      restaurant = await this.restaurantRepo.findOne({ where: { slug: dto.restaurantSlug } });
    }

    if (!restaurant) {
      throw new NotFoundException('Restaurant not found for menu item');
    }

    await this.assertCategory(dto.categoryId, restaurant.id);

    const item = this.menuItemRepo.create({
      name: dto.name.trim(),
      description: dto.description || '',
      price: dto.price,
      categoryId: dto.categoryId,
      restaurantId: restaurant.id,
      isVeg: dto.isVeg ?? true,
      imageUrl: dto.imageUrl || '🍽️',
      isAvailable: true,
      isPopular: false,
    });

    const savedItem = await this.menuItemRepo.save(item);

    if (Array.isArray(dto.modifiers) && dto.modifiers.length > 0) {
      const modifierEntities = dto.modifiers.map((m) =>
        this.modifierRepo.create({
          menuItemId: savedItem.id,
          name: m.name,
          type: m.type || ModifierType.SINGLE,
          isRequired: Boolean(m.isRequired),
          options: m.options || [],
        }),
      );
      await this.modifierRepo.save(modifierEntities);
    }

    return this.menuItemRepo.findOne({
      where: { id: savedItem.id },
      relations: { modifiers: true },
    });
  }

  async updateItem(id: string, dto: UpdateItemDto, authorizedRestaurantId?: string) {
    const item = await this.menuItemRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Menu item '${id}' not found`);
    }
    if (authorizedRestaurantId && item.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Menu item does not belong to authorized restaurant');
    }

    if (dto.name !== undefined) item.name = dto.name;
    if (dto.description !== undefined) item.description = dto.description;
    if (dto.price !== undefined) item.price = dto.price;
    if (dto.categoryId !== undefined) {
      await this.assertCategory(dto.categoryId, item.restaurantId);
      item.categoryId = dto.categoryId;
    }
    if (dto.isVeg !== undefined) item.isVeg = dto.isVeg;
    if (dto.imageUrl !== undefined) item.imageUrl = dto.imageUrl;
    if (dto.isAvailable !== undefined) {
      item.isAvailable = dto.isAvailable;
      item.autoDisabled = false;
    }

    await this.menuItemRepo.save(item);

    if (Array.isArray(dto.modifiers)) {
      // Replace existing modifiers
      await this.modifierRepo.delete({ menuItemId: id });
      if (dto.modifiers.length > 0) {
        const modifierEntities = dto.modifiers.map((m) =>
          this.modifierRepo.create({
            menuItemId: id,
            name: m.name,
            type: m.type || ModifierType.SINGLE,
            isRequired: Boolean(m.isRequired),
            options: m.options || [],
          }),
        );
        await this.modifierRepo.save(modifierEntities);
      }
    }

    return this.menuItemRepo.findOne({
      where: { id },
      relations: { modifiers: true },
    });
  }
}
