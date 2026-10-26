import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Staff } from '../auth/entities/staff.entity.js';
import { Organization } from '../organizations/entities/organization.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { MenuCategory } from '../menu/entities/menu-category.entity.js';
import { MenuItem } from '../menu/entities/menu-item.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { Lead } from '../leads/entities/lead.entity.js';
import { LeadStatus, OrderStatus, StaffRole, TableStatus } from '../common/enums/index.js';
import { ProvisionRestaurantDto } from './dto/provision-restaurant.dto.js';
import { UpdateLeadDto } from '../leads/dto/update-lead.dto.js';
import { EventsGateway } from '../events/events.gateway.js';

@Injectable()
export class AdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly eventsGateway: EventsGateway,
  ) {}

  async getMetrics() {
    const orgRepo = this.dataSource.getRepository(Organization);
    const restRepo = this.dataSource.getRepository(Restaurant);
    const orderRepo = this.dataSource.getRepository(Order);
    const leadRepo = this.dataSource.getRepository(Lead);

    const [totalOrganizations, totalOutlets, activeOutlets, totalOrders, totalLeads, newLeads] =
      await Promise.all([
        orgRepo.count(),
        restRepo.count(),
        restRepo.count({ where: { isActive: true } }),
        orderRepo.count(),
        leadRepo.count(),
        leadRepo.count({ where: { status: LeadStatus.NEW } }),
      ]);

    const gmvResult = await orderRepo
      .createQueryBuilder('order')
      .select('SUM(order.total_amount)', 'gmv')
      .getRawOne();

    const systemGmv = Number(gmvResult?.gmv || 0);

    return {
      totalOrganizations,
      totalOutlets,
      activeOutlets,
      totalOrders,
      systemGmv,
      totalLeads,
      newLeads,
      systemHealth: {
        status: 'HEALTHY',
        database: 'CONNECTED',
        gateway: 'ONLINE',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      },
    };
  }

  async getLeads() {
    const leadRepo = this.dataSource.getRepository(Lead);
    return leadRepo.find({
      order: { createdAt: 'DESC' },
    });
  }

  async updateLead(id: string, dto: UpdateLeadDto) {
    const leadRepo = this.dataSource.getRepository(Lead);
    const lead = await leadRepo.findOne({ where: { id } });
    if (!lead) {
      throw new NotFoundException(`Lead with id '${id}' not found`);
    }
    if (dto.status !== undefined) {
      lead.status = dto.status;
    }
    if (dto.notes !== undefined) {
      lead.notes = dto.notes;
    }
    return leadRepo.save(lead);
  }

  async provisionRestaurant(dto: ProvisionRestaurantDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const temporaryPassword =
      dto.password?.trim() ||
      `Pangat@${Math.floor(1000 + Math.random() * 9000)}`;

    try {
      // 1. Check if email already registered
      const existingStaff = await queryRunner.manager.findOne(Staff, {
        where: { email: dto.email.trim().toLowerCase() },
      });
      if (existingStaff) {
        throw new BadRequestException(
          `Staff user with email '${dto.email}' is already registered`,
        );
      }

      // 2. Format & check restaurant slug
      const sanitizedSlug = dto.slug
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-');

      const existingSlug = await queryRunner.manager.findOne(Restaurant, {
        where: { slug: sanitizedSlug },
      });
      if (existingSlug) {
        throw new BadRequestException(
          `An outlet with the slug '${sanitizedSlug}' already exists`,
        );
      }

      // 3. Create Organization
      const org = queryRunner.manager.create(Organization, {
        name: dto.brandName.trim(),
      });
      const savedOrg = await queryRunner.manager.save(Organization, org);

      // 4. Create Super Owner Staff record
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);
      const superOwner = queryRunner.manager.create(Staff, {
        name: dto.ownerFullName.trim(),
        email: dto.email.trim().toLowerCase(),
        passwordHash,
        role: StaffRole.SUPER_OWNER,
        organizationId: savedOrg.id,
        restaurantId: null,
        isPlatformAdmin: false,
      });
      const savedSuperOwner = await queryRunner.manager.save(Staff, superOwner);

      // Link ownerId on Organization
      savedOrg.ownerId = savedSuperOwner.id;
      await queryRunner.manager.save(Organization, savedOrg);

      // 5. Create Outlet
      const outlet = queryRunner.manager.create(Restaurant, {
        name: dto.outletName.trim(),
        slug: sanitizedSlug,
        branchArea: dto.branchArea?.trim() || null,
        phone: dto.mobileNumber.trim(),
        email: dto.email.trim().toLowerCase(),
        organizationId: savedOrg.id,
        upiVpa: dto.upiVpa.trim(),
        gstin: dto.gstin?.trim() || null,
        gstPercentage: dto.gstPercentage ?? 5,
        isVegOnly: false,
        isActive: true,
        kdsNewOrderAlert: true,
        orderReadyChime: true,
        outOfStockNotification: true,
      });
      const savedOutlet = await queryRunner.manager.save(Restaurant, outlet);

      // 6. Generate Batch Tables (Indoor & Outdoor)
      const indoorCount = Math.max(1, dto.indoorTableCount ?? 12);
      const outdoorCount = Math.max(0, dto.outdoorTableCount ?? 4);
      const createdTables: Table[] = [];

      for (let i = 1; i <= indoorCount; i++) {
        const tableNum = `T${String(i).padStart(2, '0')}`;
        const table = queryRunner.manager.create(Table, {
          restaurantId: savedOutlet.id,
          tableNumber: tableNum,
          status: TableStatus.VACANT,
          qrCodeUrl: `/r/${savedOutlet.slug}/t/${tableNum}`,
        });
        createdTables.push(table);
      }

      for (let i = 1; i <= outdoorCount; i++) {
        const tableNum = `OD${String(i).padStart(2, '0')}`;
        const table = queryRunner.manager.create(Table, {
          restaurantId: savedOutlet.id,
          tableNumber: tableNum,
          status: TableStatus.VACANT,
          qrCodeUrl: `/r/${savedOutlet.slug}/t/${tableNum}`,
        });
        createdTables.push(table);
      }

      const savedTables = await queryRunner.manager.save(Table, createdTables);

      // 7. Starter Menu Preset Selection
      let menuItemsCount = 0;
      if (dto.menuPreset === 'pune_cafe' || !dto.menuPreset) {
        const catSnacks = await queryRunner.manager.save(
          MenuCategory,
          queryRunner.manager.create(MenuCategory, {
            restaurantId: savedOutlet.id,
            name: 'Nashta & Bites',
            sortOrder: 1,
          }),
        );
        const catChai = await queryRunner.manager.save(
          MenuCategory,
          queryRunner.manager.create(MenuCategory, {
            restaurantId: savedOutlet.id,
            name: 'Chai & Drinks',
            sortOrder: 2,
          }),
        );

        const items = [
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catSnacks.id,
            name: 'Puneri Misal Pav',
            description:
              'Sprouted moth beans in fiery rassa topped with Pune farsan & chopped onions',
            price: 110,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🌶️',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catSnacks.id,
            name: 'Kanda Batata Poha',
            description:
              'Flattened rice tempered with mustard, turmeric, soft potatoes, and crunchy peanuts',
            price: 50,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🥣',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catSnacks.id,
            name: 'Bun Maska & Brun',
            description:
              'Fresh Irani bakery bun slathered with wholesome Amul white butter',
            price: 45,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🍞',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catChai.id,
            name: 'Special Masala Chai',
            description:
              'Fresh brewed milk tea simmered with ginger, crushed cardamom, and lemongrass',
            price: 30,
            isVeg: true,
            isAvailable: true,
            imageUrl: '☕',
          }),
        ];
        await queryRunner.manager.save(MenuItem, items);
        menuItemsCount = items.length;
      } else if (dto.menuPreset === 'south_indian') {
        const catTiffin = await queryRunner.manager.save(
          MenuCategory,
          queryRunner.manager.create(MenuCategory, {
            restaurantId: savedOutlet.id,
            name: 'Tiffin Specials',
            sortOrder: 1,
          }),
        );
        const catBev = await queryRunner.manager.save(
          MenuCategory,
          queryRunner.manager.create(MenuCategory, {
            restaurantId: savedOutlet.id,
            name: 'Hot Brews',
            sortOrder: 2,
          }),
        );

        const items = [
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catTiffin.id,
            name: 'Crispy Masala Dosa',
            description:
              'Golden roasted crepe stuffed with spiced potato masala, served with chutney & sambar',
            price: 120,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🥞',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catTiffin.id,
            name: 'Steamed Ghee Idli-Vada',
            description:
              'Duo of fluffy steamed rice cakes and a crispy medu vada dunked in aromatic sambar',
            price: 80,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🥟',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catBev.id,
            name: 'Kumbakonam Degree Filter Coffee',
            description:
              'Strong chicory-blend decoction frothed with boiling whole milk',
            price: 40,
            isVeg: true,
            isAvailable: true,
            imageUrl: '☕',
          }),
        ];
        await queryRunner.manager.save(MenuItem, items);
        menuItemsCount = items.length;
      }

      // 8. If linked to a captured lead, mark lead as ONBOARDED
      if (dto.leadId) {
        const lead = await queryRunner.manager.findOne(Lead, {
          where: { id: dto.leadId },
        });
        if (lead) {
          lead.status = LeadStatus.ONBOARDED;
          lead.notes = lead.notes
            ? `${lead.notes} | Provisioned as outlet '${savedOutlet.slug}' on ${new Date().toISOString()}`
            : `Provisioned as outlet '${savedOutlet.slug}' on ${new Date().toISOString()}`;
          await queryRunner.manager.save(Lead, lead);
        }
      }

      // Commit transaction cleanly
      await queryRunner.commitTransaction();

      return {
        success: true,
        message: `Successfully provisioned ${savedOrg.name} (${savedOutlet.name})!`,
        organization: {
          id: savedOrg.id,
          name: savedOrg.name,
        },
        outlet: {
          id: savedOutlet.id,
          name: savedOutlet.name,
          slug: savedOutlet.slug,
          branchArea: savedOutlet.branchArea,
          upiVpa: savedOutlet.upiVpa,
          phone: savedOutlet.phone,
        },
        ownerCredentials: {
          name: savedSuperOwner.name,
          email: savedSuperOwner.email,
          temporaryPassword,
          loginUrl: '/login',
        },
        batchTablesCreated: savedTables.length,
        menuItemsSeeded: menuItemsCount,
        qrKitLink: `/r/${savedOutlet.slug}/t/T01`,
      };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async getOrganizations() {
    const orgRepo = this.dataSource.getRepository(Organization);
    const orgs = await orgRepo.find({
      relations: { restaurants: true },
      order: { createdAt: 'DESC' },
    });

    const staffRepo = this.dataSource.getRepository(Staff);
    const orderRepo = this.dataSource.getRepository(Order);

    const result = await Promise.all(
      orgs.map(async (org) => {
        const owner = org.ownerId
          ? await staffRepo.findOne({ where: { id: org.ownerId } })
          : await staffRepo.findOne({
              where: { organizationId: org.id, role: StaffRole.SUPER_OWNER },
            });

        const outlets = org.restaurants || [];
        const outletIds = outlets.map((o) => o.id);
        let orgGmv = 0;
        let totalOrders = 0;

        if (outletIds.length > 0) {
          const gmvRes = await orderRepo
            .createQueryBuilder('order')
            .select('SUM(order.total_amount)', 'gmv')
            .addSelect('COUNT(order.id)', 'count')
            .where('order.restaurant_id IN (:...outletIds)', { outletIds })
            .getRawOne();
          orgGmv = Number(gmvRes?.gmv || 0);
          totalOrders = Number(gmvRes?.count || 0);
        }

        const activeOutlets = outlets.filter((o) => o.isActive).length;

        return {
          id: org.id,
          name: org.name,
          createdAt: org.createdAt,
          owner: {
            id: owner?.id || null,
            name: owner?.name || 'Unassigned',
            email: owner?.email || '—',
            phone: outlets[0]?.phone || '—',
          },
          outletsCount: outlets.length,
          activeOutletsCount: activeOutlets,
          outlets: outlets.map((o) => ({
            id: o.id,
            name: o.name,
            slug: o.slug,
            branchArea: o.branchArea,
            isActive: o.isActive,
            upiVpa: o.upiVpa,
          })),
          totalGmv: orgGmv,
          totalOrders,
          status: activeOutlets > 0 ? 'ACTIVE' : 'INACTIVE',
        };
      }),
    );

    return result;
  }

  async resetOrganizationPassword(orgId: string) {
    const staffRepo = this.dataSource.getRepository(Staff);
    const orgRepo = this.dataSource.getRepository(Organization);

    const org = await orgRepo.findOne({ where: { id: orgId } });
    if (!org) {
      throw new NotFoundException(`Organization with id '${orgId}' not found`);
    }

    const owner = org.ownerId
      ? await staffRepo.findOne({ where: { id: org.ownerId } })
      : await staffRepo.findOne({
          where: { organizationId: orgId, role: StaffRole.SUPER_OWNER },
        });

    if (!owner) {
      throw new NotFoundException(
        `Super Owner staff record not found for organization '${org.name}'`,
      );
    }

    const tempPassword = `Pangat#${Math.floor(1000 + Math.random() * 9000)}`;
    owner.passwordHash = await bcrypt.hash(tempPassword, 10);
    await staffRepo.save(owner);

    return {
      success: true,
      message: `Password reset successfully for ${owner.name}`,
      ownerName: owner.name,
      ownerEmail: owner.email,
      temporaryPassword: tempPassword,
      organizationName: org.name,
    };
  }

  async getOutlets() {
    const restRepo = this.dataSource.getRepository(Restaurant);
    const tableRepo = this.dataSource.getRepository(Table);
    const orderRepo = this.dataSource.getRepository(Order);

    const outlets = await restRepo.find({
      relations: { organization: true },
      order: { createdAt: 'DESC' },
    });

    const result = await Promise.all(
      outlets.map(async (outlet) => {
        const [tablesCount, activeOrdersCount] = await Promise.all([
          tableRepo.count({ where: { restaurantId: outlet.id } }),
          orderRepo.count({
            where: {
              restaurantId: outlet.id,
              orderStatus: OrderStatus.PREPARING,
            },
          }),
        ]);

        const isOnline = this.eventsGateway.isOutletOnline(outlet.slug);

        return {
          id: outlet.id,
          name: outlet.name,
          slug: outlet.slug,
          branchArea: outlet.branchArea || '—',
          phone: outlet.phone || '—',
          email: outlet.email || '—',
          upiVpa: outlet.upiVpa,
          gstPercentage: outlet.gstPercentage,
          isActive: outlet.isActive,
          organizationId: outlet.organizationId,
          organizationName: outlet.organization?.name || 'Unassigned',
          tablesCount,
          activeOrdersCount,
          isOnline,
        };
      }),
    );

    return result;
  }

  async getSystemHealth() {
    let dbStatus = 'CONNECTED';
    let dbLatencyMs = 0;
    try {
      const start = Date.now();
      await this.dataSource.query('SELECT 1');
      dbLatencyMs = Date.now() - start;
    } catch {
      dbStatus = 'DISCONNECTED';
    }

    const mem = process.memoryUsage();

    return {
      status: dbStatus === 'CONNECTED' ? 'HEALTHY' : 'DEGRADED',
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
        client: 'Neon Cloud Serverless PostgreSQL',
      },
      websocket: {
        connectedClients: this.eventsGateway.getConnectedSocketsCount(),
        activeOutletRooms: this.eventsGateway.getActiveOutletSlugs(),
      },
      server: {
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        memoryRssMb: Math.round(mem.rss / 1024 / 1024),
        memoryHeapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        timestamp: new Date().toISOString(),
      },
    };
  }
}
