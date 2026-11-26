import { EventsGateway } from '../events/events.gateway.js';
import { AuditService } from '../audit/audit.service.js';
import { Optional, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { getOrderingStatus, resolveOperations, upiOffered } from '../restaurants/operations.js';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { MenuItem } from './entities/menu-item.entity.js';
import { MenuCategory } from './entities/menu-category.entity.js';
import { Modifier } from './entities/modifier.entity.js';
import { ModifierType } from '../common/enums/index.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { CreateItemDto, ImportMenuDto, UpdateItemDto } from './dto/create-item.dto.js';
import { DEFAULT_CATEGORY, normKey, parseMenuCsv } from './menu-import.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { decideFeature, getOrgAccess } from '../subscriptions/subscription-access.js';

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
    @Optional()
    private readonly eventsGateway?: EventsGateway,
  ) {}

  /**
   * Whether guests may order: the outlet's own switches/hours AND the subscription (QR_ORDERING in the plan, platform switches,
   * lapsed subscription). The menu itself stays readable; ordering is what the plan sells.
   */
  private async orderingFor(restaurant: Restaurant) {
    const own = getOrderingStatus(restaurant.operations);
    if (!restaurant.organizationId) return own;
    const ds = this.restaurantRepo.manager.connection;
    const [feature, access] = await Promise.all([
      decideFeature(ds, restaurant.organizationId, 'QR_ORDERING'),
      getOrgAccess(ds, restaurant.organizationId),
    ]);
    if (feature.allowed && !access.blocked) return own;
    return { ...own, accepting: false, reason: 'closed' as const, message: 'This outlet is not taking orders right now. Please ask a staff member.' };
  }

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
        // the UPI ID is only ever sent to guests while the owner has confirmed it and UPI is switched on for this outlet
        upiVpa: upiOffered(restaurant) ? restaurant.upiVpa : '',
        gstPercentage: Number(restaurant.gstPercentage),
        serviceChargePercentage: Number(restaurant.serviceChargePercentage ?? 0),
        isVegOnly: restaurant.isVegOnly,
        operations: (() => { const o = resolveOperations(restaurant.operations); return { ...o, payments: { ...o.payments, upi: upiOffered(restaurant) } }; })(),
        ordering: await this.orderingFor(restaurant),
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

  async updateAvailability(id: string, isAvailable: boolean, authorizedRestaurantId?: string, actor?: any) {
    const item = await this.menuItemRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Menu item '${id}' not found`);
    }
    if (authorizedRestaurantId && item.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Menu item does not belong to authorized restaurant');
    }
    const wasAvailable = item.isAvailable;
    item.isAvailable = isAvailable;
    item.autoDisabled = false; // a manual choice always wins over the automatic one
    const saved = await this.menuItemRepo.manager.transaction(async (em) => {
      const persisted = await em.getRepository(MenuItem).save(item);
      if (wasAvailable !== isAvailable) await this.audit(em, item.restaurantId, 'MENU_ITEM', item.id, isAvailable ? 'ITEM_MARKED_AVAILABLE' : 'ITEM_MARKED_SOLD_OUT', actor, { name: item.name });
      return persisted;
    });
    const outlet = await this.restaurantRepo.findOne({ where: { id: item.restaurantId } });
    if (outlet) this.eventsGateway?.emitMenuAvailability(outlet.slug, { id: item.id, name: item.name, isAvailable, auto: false });
    return saved;
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
    return this.menuItemRepo.manager.transaction(async (em) => {
      const persisted = await em.getRepository(MenuItem).save(item);
      await this.audit(em, item.restaurantId, 'MENU_ITEM', item.id, 'PRICE_CHANGED', actor, { name: item.name, from: previous, to: price });
      return persisted;
    });
  }

  /** Writes the audit entry in the caller's transaction; throws on failure so a change is never saved without its record. */
  private async audit(em: EntityManager, restaurantId: string, entityType: string, entityId: string, action: string, actor: any, metadata: Record<string, any>, organizationId?: string | null) {
    await this.auditService.record({
      restaurantId, organizationId: organizationId ?? null, entityType, entityId, action,
      staffId: actor?.id, staffName: actor?.name, staffRole: actor?.role, staffEmail: actor?.email, metadata,
    }, em);
  }

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
    await this.menuItemRepo.manager.transaction(async (em) => {
      await em.getRepository(MenuItem).softRemove(item);
      await this.audit(em, item.restaurantId, 'MENU_ITEM', item.id, 'ITEM_DELETED', actor, { name: item.name, price: Number(item.price) });
    });
  }

  async updateCategory(id: string, dto: { name?: string; sortOrder?: number }, authorizedRestaurantId?: string, actor?: any) {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) throw new NotFoundException(`Category '${id}' not found`);
    if (authorizedRestaurantId && category.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Category does not belong to authorized restaurant');
    }
    const categoryBefore = category.name;
    const sortBefore = category.sortOrder;
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Category name cannot be empty');
      category.name = name;
    }
    const before = { name: categoryBefore, sortOrder: sortBefore };
    if (dto.sortOrder !== undefined) category.sortOrder = dto.sortOrder;
    return this.categoryRepo.manager.transaction(async (em) => {
      const persisted = await em.getRepository(MenuCategory).save(category);
      await this.audit(em, category.restaurantId, 'MENU_CATEGORY', category.id, 'CATEGORY_UPDATED', actor, { before, after: { name: persisted.name, sortOrder: persisted.sortOrder } });
      return persisted;
    });
  }

  async createCategory(dto: CreateCategoryDto, actor?: any) {
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

    return this.categoryRepo.manager.transaction(async (em) => {
      const persisted = await em.getRepository(MenuCategory).save(category);
      await this.audit(em, restaurant!.id, 'MENU_CATEGORY', persisted.id, 'CATEGORY_CREATED', actor, { name: persisted.name });
      return persisted;
    });
  }

  async removeCategory(id: string, authorizedRestaurantId?: string, actor?: any) {
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

    await this.categoryRepo.manager.transaction(async (em) => {
      await this.audit(em, category.restaurantId, 'MENU_CATEGORY', id, 'CATEGORY_DELETED', actor, { name: category.name });
      await em.getRepository(MenuCategory).remove(category);
    });
  }

  async createItem(dto: CreateItemDto, actor?: any) {
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

    const savedItem = await this.menuItemRepo.manager.transaction(async (em) => {
      const persisted = await em.getRepository(MenuItem).save(item);
      if (Array.isArray(dto.modifiers) && dto.modifiers.length > 0) {
        const modifierEntities = dto.modifiers.map((m) =>
          em.getRepository(Modifier).create({
            menuItemId: persisted.id,
            name: m.name,
            type: m.type || ModifierType.SINGLE,
            isRequired: Boolean(m.isRequired),
            options: m.options || [],
          }),
        );
        await em.getRepository(Modifier).save(modifierEntities);
      }
      await this.audit(em, restaurant!.id, 'MENU_ITEM', persisted.id, 'ITEM_CREATED', actor, { name: persisted.name, price: Number(persisted.price), modifiers: dto.modifiers?.length ?? 0 });
      return persisted;
    });

    return this.menuItemRepo.findOne({
      where: { id: savedItem.id },
      relations: { modifiers: true },
    });
  }

  /**
   * Bulk menu entry from a CSV. Safe by construction:
   *  - `dryRun` validates and previews exactly what would happen and writes nothing;
   *  - the real import is ONE transaction: all dishes and categories, or none;
   *  - it is repeatable: a dish that already exists (same category and name) is skipped, so importing the same file twice adds nothing;
   *  - it only ever creates (and, if asked, re-prices): it never deletes or renames anything.
   */
  async importCsv(dto: ImportMenuDto, actor?: any) {
    let restaurant: Restaurant | null = null;
    if (dto.restaurantId) restaurant = await this.restaurantRepo.findOne({ where: { id: dto.restaurantId } });
    else if (dto.restaurantSlug) restaurant = await this.restaurantRepo.findOne({ where: { slug: dto.restaurantSlug } });
    if (!restaurant) throw new NotFoundException('Restaurant not found for the menu import');

    const parsed = parseMenuCsv(dto.csv);
    if (parsed.fileErrors.length) throw new BadRequestException({ message: parsed.fileErrors, code: 'MENU_IMPORT_FILE_INVALID' });

    const isPreview = dto.dryRun !== false; // preview is the default: an import must be asked for explicitly

    /** Read the current menu and decide, per row, what would happen. Run INSIDE the locked transaction for a real import. */
    const planImport = async (em: EntityManager) => {
      const categories = await em.getRepository(MenuCategory).find({ where: { restaurantId: restaurant!.id } });
      const items = await em.getRepository(MenuItem).find({ where: { restaurantId: restaurant!.id } }); // soft-deleted dishes are excluded
      const catByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c]));
      const existing = new Map<string, MenuItem>();
      for (const it of items) {
        const c = categories.find((x) => x.id === it.categoryId);
        existing.set(normKey(c?.name ?? DEFAULT_CATEGORY, it.name), it);
      }
      type Plan = { line: number; category: string; name: string; price: number; action: 'create' | 'update' | 'skip'; reason?: string };
      const plan: Plan[] = [];
      const seen = new Map<string, number>();
      for (const r of parsed.rows) {
        const key = normKey(r.category, r.name);
        const base = { line: r.line, category: r.category, name: r.name, price: r.price };
        if (seen.has(key)) { plan.push({ ...base, action: 'skip', reason: `Same dish as line ${seen.get(key)} in this file.` }); continue; }
        seen.set(key, r.line);
        const have = existing.get(key);
        if (!have) plan.push({ ...base, action: 'create' });
        else if (dto.updatePrices && Number(have.price) !== r.price) plan.push({ ...base, action: 'update', reason: `Price ${Number(have.price)} to ${r.price}.` });
        else plan.push({ ...base, action: 'skip', reason: 'Already on the menu.' });
      }
      const newCategories = [...new Set(parsed.rows.filter((r) => plan.find((p) => p.line === r.line)?.action === 'create').map((r) => r.category))]
        .filter((name) => !catByName.has(name.trim().toLowerCase()));
      const summary = {
        create: plan.filter((p) => p.action === 'create').length,
        update: plan.filter((p) => p.action === 'update').length,
        skip: plan.filter((p) => p.action === 'skip').length,
        errors: parsed.errors.length,
        newCategories: newCategories.length,
      };
      return { categories, catByName, existing, plan, newCategories, summary, preview: { dryRun: isPreview, summary, rows: plan, errors: parsed.errors, newCategories } };
    };

    if (isPreview) return (await planImport(this.menuItemRepo.manager)).preview;
    if (parsed.errors.length) {
      const p = await planImport(this.menuItemRepo.manager);
      throw new BadRequestException({ message: ['Fix the rows with errors (or remove them) and try again. Nothing was imported.'], code: 'MENU_IMPORT_ROW_ERRORS', details: p.preview });
    }

    return this.menuItemRepo.manager.transaction(async (em) => {
      // One import at a time per restaurant: the next one waits, then re-reads the menu and so sees what this one created (no duplicates).
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`menu-import:${restaurant!.id}`]);
      const { categories, catByName, existing, plan, newCategories, summary, preview } = await planImport(em);
      let sort = categories.reduce((m, c) => Math.max(m, c.sortOrder ?? 0), 0);
      const created = new Map<string, MenuCategory>();
      for (const name of newCategories) {
        const c = await em.getRepository(MenuCategory).save(em.getRepository(MenuCategory).create({ name, restaurantId: restaurant!.id, sortOrder: ++sort }));
        created.set(name.trim().toLowerCase(), c);
      }
      const catId = (name: string) => (catByName.get(name.trim().toLowerCase()) ?? created.get(name.trim().toLowerCase()))!.id;
      const rowByLine = new Map(parsed.rows.map((r) => [r.line, r]));
      for (const p of plan) {
        const r = rowByLine.get(p.line)!;
        if (p.action === 'create') {
          await em.getRepository(MenuItem).save(em.getRepository(MenuItem).create({
            name: r.name, description: r.description, price: r.price, categoryId: catId(r.category), restaurantId: restaurant!.id,
            isVeg: r.isVeg, isAvailable: r.isAvailable, isPopular: false, imageUrl: '🍽️',
          }));
        } else if (p.action === 'update') {
          const have = existing.get(normKey(r.category, r.name))!;
          have.price = r.price;
          await em.getRepository(MenuItem).save(have);
        }
      }
      await this.audit(em, restaurant!.id, 'MENU', restaurant!.id, 'MENU_IMPORTED', actor, { ...summary, updatePrices: !!dto.updatePrices }, restaurant!.organizationId);
      return { ...preview, dryRun: false };
    });
  }

  async updateItem(id: string, dto: UpdateItemDto, authorizedRestaurantId?: string, actor?: any) {
    const item = await this.menuItemRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Menu item '${id}' not found`);
    }
    if (authorizedRestaurantId && item.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Menu item does not belong to authorized restaurant');
    }

    const before = { name: item.name, price: Number(item.price), categoryId: item.categoryId, isVeg: item.isVeg, isAvailable: item.isAvailable, description: item.description };
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

    await this.menuItemRepo.manager.transaction(async (em) => {
      await em.getRepository(MenuItem).save(item);
      if (Array.isArray(dto.modifiers)) {
        // Replace existing modifiers
        await em.getRepository(Modifier).delete({ menuItemId: id });
        if (dto.modifiers.length > 0) {
          await em.getRepository(Modifier).save(
            dto.modifiers.map((m) =>
              em.getRepository(Modifier).create({
                menuItemId: id,
                name: m.name,
                type: m.type || ModifierType.SINGLE,
                isRequired: Boolean(m.isRequired),
                options: m.options || [],
              }),
            ),
          );
        }
      }
      const after = { name: item.name, price: Number(item.price), categoryId: item.categoryId, isVeg: item.isVeg, isAvailable: item.isAvailable, description: item.description };
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => String(before[k]) !== String(after[k]));
      // A price edit made through the general edit form is a price change: it is recorded exactly like the dedicated price action
      if (changed.includes('price')) await this.audit(em, item.restaurantId, 'MENU_ITEM', item.id, 'PRICE_CHANGED', actor, { name: item.name, from: before.price, to: after.price });
      const others = changed.filter((k) => k !== 'price');
      if (others.length > 0 || Array.isArray(dto.modifiers)) {
        await this.audit(em, item.restaurantId, 'MENU_ITEM', item.id, 'ITEM_UPDATED', actor, {
          name: item.name,
          changed: [...others, ...(Array.isArray(dto.modifiers) ? ['modifiers'] : [])],
          before: Object.fromEntries(others.map((k) => [k, before[k]])),
          after: Object.fromEntries(others.map((k) => [k, after[k]])),
        });
      }
    });

    return this.menuItemRepo.findOne({
      where: { id },
      relations: { modifiers: true },
    });
  }
}
