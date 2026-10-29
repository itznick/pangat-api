import {
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Organization } from './entities/organization.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { TableStatus, StaffRole } from '../common/enums/index.js';
import { CreateOutletDto } from './dto/create-outlet.dto.js';

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    private readonly dataSource: DataSource,
  ) {}

  async listOutlets(user: any, requestedOrgId?: string): Promise<Restaurant[]> {
    if (user.role === 'PLATFORM_SUPER_ADMIN' || user.role === StaffRole.PLATFORM_SUPER_ADMIN) {
      if (requestedOrgId) {
        return this.restaurantRepo.find({
          where: { organizationId: requestedOrgId },
          order: { createdAt: 'ASC' },
        });
      }
      return this.restaurantRepo.find({
        order: { createdAt: 'ASC' },
      });
    }

    let orgId = user.organizationId;

    if (!orgId && user.restaurantId) {
      const rest = await this.restaurantRepo.findOne({
        where: { id: user.restaurantId },
      });
      if (rest?.organizationId) {
        orgId = rest.organizationId;
      }
    }

    if (!orgId) {
      return [];
    }

    return this.restaurantRepo.find({
      where: { organizationId: orgId },
      order: { createdAt: 'ASC' },
    });
  }

  async createOutlet(user: any, dto: CreateOutletDto): Promise<Restaurant> {
    let orgId = user.organizationId;

    if (!orgId && user.restaurantId) {
      const rest = await this.restaurantRepo.findOne({
        where: { id: user.restaurantId },
      });
      orgId = rest?.organizationId;
    }

    if (!orgId) {
      // Reject missing or unassociated organization instead of co-mingling into the first DB organization
      throw new BadRequestException(
        'Valid organization context is required to create a new restaurant outlet. Please contact platform administration.',
      );
    }

    // Check slug collision
    const existing = await this.restaurantRepo.findOne({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new BadRequestException(
        `An outlet with the slug '${dto.slug}' already exists`,
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const outlet = queryRunner.manager.create(Restaurant, {
        organizationId: orgId,
        name: dto.name,
        slug: dto.slug,
        branchArea: dto.branchArea || null,
        phone: dto.phone || null,
        email: dto.email || null,
        upiVpa: dto.upiVpa,
        gstin: dto.gstin || null,
        gstPercentage: dto.gstPercentage ?? 5,
        isActive: true,
        isVegOnly: false,
        kdsNewOrderAlert: true,
        orderReadyChime: true,
        outOfStockNotification: true,
      });

      const savedOutlet = await queryRunner.manager.save(Restaurant, outlet);

      // Provision initial tables
      const tableCount = Math.max(1, Math.min(50, dto.tableCount ?? 10));
      const tables: Table[] = [];
      for (let i = 1; i <= tableCount; i++) {
        const tableNum = `T${String(i).padStart(2, '0')}`;
        tables.push(
          queryRunner.manager.create(Table, {
            restaurantId: savedOutlet.id,
            tableNumber: tableNum,
            status: TableStatus.VACANT,
            qrCodeUrl: `/r/${savedOutlet.slug}/t/${tableNum}`,
          }),
        );
      }
      await queryRunner.manager.save(Table, tables);

      await queryRunner.commitTransaction();
      return savedOutlet;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
