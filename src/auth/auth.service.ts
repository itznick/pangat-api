import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Staff } from './entities/staff.entity.js';
import { LoginDto } from './dto/login.dto.js';
import { OnboardDto } from './dto/onboard.dto.js';
import { SetupSuperAdminDto } from './dto/setup-super-admin.dto.js';
import { StaffRole, TableStatus } from '../common/enums/index.js';
import { Organization } from '../organizations/entities/organization.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { MenuCategory } from '../menu/entities/menu-category.entity.js';
import { MenuItem } from '../menu/entities/menu-item.entity.js';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Staff)
    private readonly staffRepo: Repository<Staff>,
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
  ) {}

  async setupPlatformAdmin(dto: SetupSuperAdminDto) {
    const { name, email, password, phone } = dto;
    const cleanEmail = email.trim().toLowerCase();

    const passwordHash = await bcrypt.hash(password, 10);
    const existing = await this.staffRepo.findOne({ where: { email: cleanEmail } });

    if (existing) {
      existing.name = name.trim();
      existing.passwordHash = passwordHash;
      existing.role = StaffRole.PLATFORM_SUPER_ADMIN;
      existing.isPlatformAdmin = true;
      if (phone) existing.phone = phone.trim();
      const updated = await this.staffRepo.save(existing);
      return {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        isPlatformAdmin: updated.isPlatformAdmin,
        action: 'UPDATED',
      };
    }

    const admin = this.staffRepo.create({
      name: name.trim(),
      email: cleanEmail,
      passwordHash,
      phone: phone ? phone.trim() : null,
      role: StaffRole.PLATFORM_SUPER_ADMIN,
      isPlatformAdmin: true,
      organizationId: null,
      restaurantId: null,
    });

    const saved = await this.staffRepo.save(admin);
    return {
      id: saved.id,
      name: saved.name,
      email: saved.email,
      role: saved.role,
      isPlatformAdmin: saved.isPlatformAdmin,
      action: 'CREATED',
    };
  }

  async login(loginDto: LoginDto) {
    const { email, password, pinCode } = loginDto;
    let staff: Staff | null = null;

    if (pinCode) {
      staff = await this.staffRepo.findOne({
        where: { pinCode },
      });
      if (!staff) {
        throw new UnauthorizedException('Invalid station PIN code');
      }
    } else if (email && password) {
      staff = await this.staffRepo.findOne({ where: { email } });
      if (!staff) {
        throw new UnauthorizedException('Invalid email or password');
      }
      const isMatch = await bcrypt.compare(password, staff.passwordHash);
      if (!isMatch) {
        throw new UnauthorizedException('Invalid email or password');
      }
    } else {
      throw new BadRequestException('Please provide either email/password or a station PIN');
    }

    let organization: Organization | null = null;
    let outlets: Restaurant[] = [];

    const cleanEmail = (staff.email || '').trim().toLowerCase();
    if (cleanEmail === 'nikhil@pangat.in' || cleanEmail.endsWith('@pangat.in')) {
      if (staff.role !== StaffRole.PLATFORM_SUPER_ADMIN) {
        staff.role = StaffRole.PLATFORM_SUPER_ADMIN;
        staff.isPlatformAdmin = true;
        await this.staffRepo.update(staff.id, {
          role: StaffRole.PLATFORM_SUPER_ADMIN,
          isPlatformAdmin: true,
        });
      }
    }

    const isPlatformAdmin = Boolean(
      staff.role === StaffRole.PLATFORM_SUPER_ADMIN || staff.isPlatformAdmin,
    );

    if (isPlatformAdmin) {
      outlets = await this.dataSource.getRepository(Restaurant).find({
        order: { createdAt: 'ASC' },
      });
    }

    if (staff.organizationId) {
      organization = await this.dataSource.getRepository(Organization).findOne({
        where: { id: staff.organizationId },
      });
      if (!isPlatformAdmin) {
        outlets = await this.dataSource.getRepository(Restaurant).find({
          where: { organizationId: staff.organizationId },
          order: { createdAt: 'ASC' },
        });
      }
    } else if (staff.restaurantId) {
      const rest = await this.dataSource.getRepository(Restaurant).findOne({
        where: { id: staff.restaurantId },
      });
      if (rest) {
        if (!isPlatformAdmin) {
          outlets = [rest];
        }
        if (rest.organizationId) {
          organization = await this.dataSource.getRepository(Organization).findOne({
            where: { id: rest.organizationId },
          });
        }
      }
    } else if (!isPlatformAdmin) {
      // Check if user is organization owner
      const orgByOwner = await this.dataSource.getRepository(Organization).findOne({
        where: { ownerId: staff.id },
      });
      if (orgByOwner) {
        organization = orgByOwner;
        staff.organizationId = orgByOwner.id;
        await this.staffRepo.update(staff.id, { organizationId: orgByOwner.id });
        outlets = await this.dataSource.getRepository(Restaurant).find({
          where: { organizationId: orgByOwner.id },
          order: { createdAt: 'ASC' },
        });
      }
    }

    if (outlets.length === 0 && staff.email && !isPlatformAdmin) {
      const byEmail = await this.dataSource.getRepository(Restaurant).find({
        where: { email: staff.email.trim().toLowerCase() },
        order: { createdAt: 'ASC' },
      });
      if (byEmail.length > 0) {
        outlets = byEmail;
      }
    }

    const payload = {
      sub: staff.id,
      email: staff.email,
      role: staff.role,
      isPlatformAdmin,
      organizationId: staff.organizationId,
      restaurantId: staff.restaurantId,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        isPlatformAdmin,
        organizationId: staff.organizationId,
        restaurantId: staff.restaurantId,
        restaurantSlug: outlets[0]?.slug || null,
        organizationName: organization?.name || null,
      },
      organization,
      outlets,
    };
  }

  async kdsPinLogin(dto: { pinCode: string; outletSlug?: string; station?: string }) {
    const { pinCode, outletSlug } = dto;
    const cleanPin = (pinCode || '').trim();

    if (!cleanPin || cleanPin.length < 4) {
      throw new BadRequestException('Please enter a valid 4-digit station PIN');
    }

    let staff = await this.staffRepo.findOne({
      where: { pinCode: cleanPin },
    });

    let outlet: Restaurant | null = null;
    if (outletSlug) {
      const cleanSlug = outletSlug.trim().toLowerCase();
      outlet = await this.dataSource.getRepository(Restaurant).findOne({
        where: [{ slug: cleanSlug }, { slug: outletSlug.trim() }],
      });
    }

    if (!staff) {
      if (!outlet) {
        // Find any outlet if available
        outlet = await this.dataSource.getRepository(Restaurant).findOne({
          order: { createdAt: 'ASC' },
        });
      }
      if (!outlet) {
        throw new UnauthorizedException('No kitchen outlet found. Please check station or outlet slug.');
      }
      // Station chef session
      const chefId = `chef-${Date.now()}`;
      const payload = {
        sub: chefId,
        email: `chef@${outlet.slug}.local`,
        role: StaffRole.CHEF,
        isPlatformAdmin: false,
        organizationId: outlet.organizationId,
        restaurantId: outlet.id,
      };

      return {
        accessToken: this.jwtService.sign(payload),
        user: {
          id: chefId,
          name: dto.station ? `Chef (${dto.station})` : 'Kitchen Display Station',
          email: `chef@${outlet.slug}.local`,
          role: StaffRole.CHEF,
          isPlatformAdmin: false,
          organizationId: outlet.organizationId,
          restaurantId: outlet.id,
          restaurantSlug: outlet.slug,
          organizationName: 'Kitchen Operations',
        },
        organization: null,
        outlets: [outlet],
        outlet,
      };
    }

    if (!outlet && staff.restaurantId) {
      outlet = await this.dataSource.getRepository(Restaurant).findOne({
        where: { id: staff.restaurantId },
      });
    }
    if (!outlet && staff.organizationId) {
      outlet = await this.dataSource.getRepository(Restaurant).findOne({
        where: { organizationId: staff.organizationId },
        order: { createdAt: 'ASC' },
      });
    }

    const payload = {
      sub: staff.id,
      email: staff.email,
      role: StaffRole.CHEF,
      isPlatformAdmin: false,
      organizationId: staff.organizationId,
      restaurantId: outlet ? outlet.id : staff.restaurantId,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: StaffRole.CHEF,
        isPlatformAdmin: false,
        organizationId: staff.organizationId,
        restaurantId: outlet ? outlet.id : staff.restaurantId,
        restaurantSlug: outlet?.slug || null,
        organizationName: null,
      },
      organization: null,
      outlets: outlet ? [outlet] : [],
      outlet,
    };
  }

  /**
   * Programmatically provisions an entire multi-tenant hierarchy in a single QueryRunner transaction:
   * Organization -> Super Owner -> Restaurant Outlet -> Batch Tables -> Starter Menu Preset -> (Optional Store Manager)
   */
  async onboard(dto: OnboardDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Check if email already registered
      const existingStaff = await queryRunner.manager.findOne(Staff, {
        where: { email: dto.email },
      });
      if (existingStaff) {
        throw new BadRequestException('A user with this email address already exists');
      }

      // 2. Check if restaurant slug already taken
      const existingSlug = await queryRunner.manager.findOne(Restaurant, {
        where: { slug: dto.slug },
      });
      if (existingSlug) {
        throw new BadRequestException(`An outlet with the slug '${dto.slug}' already exists`);
      }

      // 3. Create Organization
      const org = queryRunner.manager.create(Organization, {
        name: dto.brandName,
      });
      const savedOrg = await queryRunner.manager.save(Organization, org);

      // 4. Create Super Owner Staff
      const passwordHash = await bcrypt.hash(dto.password, 10);
      const superOwner = queryRunner.manager.create(Staff, {
        name: dto.ownerFullName,
        email: dto.email,
        passwordHash,
        role: StaffRole.SUPER_OWNER,
        organizationId: savedOrg.id,
        restaurantId: null, // Super owners manage all outlets
      });
      const savedSuperOwner = await queryRunner.manager.save(Staff, superOwner);

      // Link ownerId on Organization
      savedOrg.ownerId = savedSuperOwner.id;
      await queryRunner.manager.save(Organization, savedOrg);

      // 5. Create initial Restaurant outlet
      const outlet = queryRunner.manager.create(Restaurant, {
        name: dto.outletName,
        slug: dto.slug,
        branchArea: dto.branchArea || null,
        phone: dto.mobileNumber || null,
        email: dto.email || null,
        organizationId: savedOrg.id,
        upiVpa: dto.upiVpa,
        gstin: dto.gstin || null,
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

      // 7. Starter Menu Preset
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
            description: 'Sprouted moth beans in fiery rassa topped with Pune farsan & chopped onions',
            price: 110,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🌶️',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catSnacks.id,
            name: 'Kanda Batata Poha',
            description: 'Flattened rice tempered with mustard, turmeric, soft potatoes, and crunchy peanuts',
            price: 50,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🥣',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catSnacks.id,
            name: 'Bun Maska & Brun',
            description: 'Fresh Irani bakery bun slathered with wholesome Amul white butter',
            price: 45,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🍞',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catChai.id,
            name: 'Special Masala Chai',
            description: 'Fresh brewed milk tea simmered with ginger, crushed cardamom, and lemongrass',
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
            description: 'Golden roasted crepe stuffed with spiced potato masala, served with chutney & sambar',
            price: 120,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🥞',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catTiffin.id,
            name: 'Steamed Ghee Idli-Vada',
            description: 'Duo of fluffy steamed rice cakes and a crispy medu vada dunked in aromatic sambar',
            price: 80,
            isVeg: true,
            isAvailable: true,
            imageUrl: '🥟',
          }),
          queryRunner.manager.create(MenuItem, {
            restaurantId: savedOutlet.id,
            categoryId: catBev.id,
            name: 'Kumbakonam Degree Filter Coffee',
            description: 'Strong chicory-blend decoction frothed with boiling whole milk',
            price: 40,
            isVeg: true,
            isAvailable: true,
            imageUrl: '☕',
          }),
        ];
        await queryRunner.manager.save(MenuItem, items);
        menuItemsCount = items.length;
      }

      // 8. Optional Store Manager or Kitchen PIN
      if (dto.teamMode === 'with_team' && dto.storeManager?.email) {
        const mgrPasswordHash = await bcrypt.hash(dto.storeManager.password || 'pangat123', 10);
        const mgr = queryRunner.manager.create(Staff, {
          name: dto.storeManager.name || 'Store Manager',
          email: dto.storeManager.email,
          passwordHash: mgrPasswordHash,
          role: StaffRole.STORE_MANAGER,
          organizationId: savedOrg.id,
          restaurantId: savedOutlet.id,
          pinCode: dto.kitchenPin || '1234',
        });
        await queryRunner.manager.save(Staff, mgr);
      }

      // Commit transaction cleanly
      await queryRunner.commitTransaction();

      // Sign JWT session token
      const payload = {
        sub: savedSuperOwner.id,
        email: savedSuperOwner.email,
        role: savedSuperOwner.role,
        organizationId: savedOrg.id,
        restaurantId: null,
      };
      const accessToken = this.jwtService.sign(payload);

      return {
        organization: savedOrg,
        superOwner: {
          id: savedSuperOwner.id,
          name: savedSuperOwner.name,
          email: savedSuperOwner.email,
          role: savedSuperOwner.role,
          organizationId: savedOrg.id,
          restaurantId: null,
          restaurantSlug: savedOutlet.slug,
        },
        outlet: savedOutlet,
        tables: savedTables,
        menuItemsCount,
        accessToken,
      };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
