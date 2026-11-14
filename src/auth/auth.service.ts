import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThan } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
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
import { AttemptLimiter } from '../common/security/attempt-limiter.js';
import { EmailDeliveryService } from '../common/services/email-delivery.service.js';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(Staff)
    private readonly staffRepo: Repository<Staff>,
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly configService: ConfigService,
  ) {}

  async setupPlatformAdmin(
    dto: SetupSuperAdminDto,
    caller?: { role?: string; isPlatformAdmin?: boolean },
    bootstrapSecret?: string,
  ) {
    const configuredSecret = this.configService.get<string>('PLATFORM_BOOTSTRAP_SECRET');
    const isTrustedBootstrap = Boolean(
      configuredSecret &&
        configuredSecret.trim().length >= 16 &&
        bootstrapSecret &&
        bootstrapSecret.trim() === configuredSecret.trim(),
    );

    const isAuthorizedAdmin = Boolean(
      caller && (caller.role === StaffRole.PLATFORM_SUPER_ADMIN || caller.isPlatformAdmin === true),
    );

    if (!isTrustedBootstrap && !isAuthorizedAdmin) {
      throw new UnauthorizedException(
        'Unauthorized: Platform admin provisioning requires authorized administrative credentials or trusted bootstrap secret',
      );
    }

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

  /** Failed password attempts before the account is locked, and for how long. */
  private static readonly MAX_FAILED_LOGINS = 5;
  private static readonly LOCK_MINUTES = 15;
  /** Per outlet+client limiter for kitchen PIN guessing (4-6 digit PINs are brute-forceable without it). */
  private readonly pinLimiter = new AttemptLimiter(5, 15 * 60_000, 15 * 60_000);
  private readonly pinOutletLimiter = new AttemptLimiter(40, 15 * 60_000, 15 * 60_000);
  /** Constant-cost dummy hash so unknown emails take as long as wrong passwords (no user enumeration by timing). */
  private static readonly DUMMY_HASH = bcrypt.hashSync('pangat-dummy-password', 10);

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    if (!email || !password) {
      throw new BadRequestException('Please provide your email and password');
    }
    const cleanEmail = email.trim().toLowerCase();
    const staff = await this.staffRepo
      .createQueryBuilder('s')
      .where('LOWER(s.email) = :email', { email: cleanEmail })
      .getOne();

    if (!staff) {
      await bcrypt.compare(password, AuthService.DUMMY_HASH);
      throw new UnauthorizedException('Invalid email or password');
    }
    if (staff.isActive === false) {
      throw new UnauthorizedException('This account has been deactivated. Contact your outlet owner.');
    }
    if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) {
      const mins = Math.ceil((staff.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new HttpException(
        `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'} or reset your password.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const isMatch = await bcrypt.compare(password, staff.passwordHash);
    if (!isMatch) {
      const failed = (staff.failedLoginCount || 0) + 1;
      const lock = failed >= AuthService.MAX_FAILED_LOGINS;
      await this.staffRepo.update(staff.id, {
        failedLoginCount: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + AuthService.LOCK_MINUTES * 60_000) : null,
      });
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.staffRepo.update(staff.id, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() });

    let organization: Organization | null = null;
    let outlets: Restaurant[] = [];

    // Security: Do NOT automatically promote users based on email domain or hardcoded emails.
    // Privileges must be granted exclusively through explicit, authorized provisioning.
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

  /**
   * Kitchen station sign-in. A station PIN belongs to ONE outlet's kitchen (CHEF) account:
   *  - the outlet slug is mandatory (a PIN is never matched across tenants),
   *  - only CHEF accounts can sign in this way (a manager's / owner's PIN can never open a privileged session),
   *  - PINs are stored hashed (legacy plain-text PINs are upgraded on the first successful sign-in),
   *  - repeated failures from one client, or against one outlet, are locked out.
   */
  async kdsPinLogin(dto: { pinCode: string; outletSlug?: string; station?: string }, clientIp = 'unknown') {
    const cleanPin = (dto.pinCode || '').trim();
    const cleanSlug = (dto.outletSlug || '').trim().toLowerCase();

    if (!/^\d{4,6}$/.test(cleanPin)) {
      throw new BadRequestException('Enter your 4 to 6 digit station PIN');
    }
    if (!cleanSlug) {
      throw new BadRequestException('Outlet slug is required for kitchen sign-in');
    }

    const clientKey = `${cleanSlug}|${clientIp}`;
    const wait = Math.max(this.pinLimiter.retryAfterSeconds(clientKey), this.pinOutletLimiter.retryAfterSeconds(cleanSlug));
    if (wait > 0) {
      throw new HttpException(
        `Too many wrong PIN attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const outlet = await this.dataSource.getRepository(Restaurant).findOne({ where: { slug: cleanSlug } });
    const stations = outlet
      ? await this.staffRepo.find({
          where: { restaurantId: outlet.id, role: StaffRole.CHEF },
        })
      : [];

    let matched: Staff | null = null;
    for (const st of stations) {
      if (st.isActive === false) continue;
      if (st.pinHash) {
        if (await bcrypt.compare(cleanPin, st.pinHash)) {
          matched = st;
          break;
        }
      } else if (st.pinCode) {
        // Legacy plain-text PIN: compare in constant time, then upgrade to a hash
        const a = Buffer.from(st.pinCode);
        const b = Buffer.from(cleanPin);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          matched = st;
          break;
        }
      }
    }
    if (!stations.length) {
      await bcrypt.compare(cleanPin, AuthService.DUMMY_HASH); // keep timing similar when the outlet has no station
    }

    if (!matched || !outlet) {
      this.pinLimiter.fail(clientKey);
      this.pinOutletLimiter.fail(cleanSlug);
      throw new UnauthorizedException('Invalid station PIN for this outlet');
    }
    this.pinLimiter.succeed(clientKey);

    if (!matched.pinHash) {
      await this.staffRepo.update(matched.id, { pinHash: await bcrypt.hash(cleanPin, 10), pinCode: null });
    }
    await this.staffRepo.update(matched.id, { lastLoginAt: new Date() });

    const payload = {
      sub: matched.id,
      email: matched.email,
      role: StaffRole.CHEF,
      isPlatformAdmin: false,
      organizationId: matched.organizationId,
      restaurantId: outlet.id,
    };

    return {
      accessToken: this.jwtService.sign(payload, { expiresIn: '16h' }),
      user: {
        id: matched.id,
        name: matched.name,
        email: matched.email,
        role: StaffRole.CHEF,
        isPlatformAdmin: false,
        organizationId: matched.organizationId,
        restaurantId: outlet.id,
        restaurantSlug: outlet.slug,
        organizationName: null,
      },
      organization: null,
      outlets: [outlet],
      outlet,
    };
  }

  /** Current user profile (fresh from the database, never from the token). */
  async me(userId: string) {
    const staff = await this.staffRepo.findOne({ where: { id: userId } });
    if (!staff) throw new UnauthorizedException('User account no longer exists');
    return {
      id: staff.id,
      name: staff.name,
      email: staff.email,
      phone: staff.phone,
      role: staff.role,
      organizationId: staff.organizationId,
      restaurantId: staff.restaurantId,
      lastLoginAt: staff.lastLoginAt,
    };
  }

  /** Update own name / phone. */
  async updateProfile(userId: string, dto: { name?: string; phone?: string }) {
    const staff = await this.staffRepo.findOne({ where: { id: userId } });
    if (!staff) throw new UnauthorizedException('User account no longer exists');
    if (dto.name !== undefined) staff.name = dto.name.trim().slice(0, 120) || staff.name;
    if (dto.phone !== undefined) staff.phone = dto.phone.trim().slice(0, 30) || null;
    await this.staffRepo.save(staff);
    return this.me(userId);
  }

  /** Change own password (requires the current one). Signs out every other session. */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const staff = await this.staffRepo.findOne({ where: { id: userId } });
    if (!staff) throw new UnauthorizedException('User account no longer exists');
    if (!(await bcrypt.compare(currentPassword, staff.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException('Choose a new password that differs from the current one');
    }
    staff.passwordHash = await bcrypt.hash(newPassword, 10);
    staff.passwordChangedAt = new Date();
    staff.failedLoginCount = 0;
    staff.lockedUntil = null;
    await this.staffRepo.save(staff);
    // fresh token so the caller stays signed in on this device
    const payload = {
      sub: staff.id,
      email: staff.email,
      role: staff.role,
      isPlatformAdmin: Boolean(staff.isPlatformAdmin || staff.role === StaffRole.PLATFORM_SUPER_ADMIN),
      organizationId: staff.organizationId,
      restaurantId: staff.restaurantId,
    };
    return { accessToken: this.jwtService.sign(payload), message: 'Password updated. Other devices were signed out.' };
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
      dto.email = dto.email.trim().toLowerCase();
      dto.slug = dto.slug.trim().toLowerCase();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(dto.slug)) {
        throw new BadRequestException('Outlet slug may only contain lowercase letters, numbers and hyphens');
      }
      // 1. Check if email already registered (case-insensitive)
      const existingStaff = await queryRunner.manager
        .createQueryBuilder(Staff, 's')
        .where('LOWER(s.email) = :email', { email: dto.email })
        .getOne();
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

      // 4. Create Super Owner Staff (Public onboarding creates only restaurant SUPER_OWNER, never platform admins)
      const passwordHash = await bcrypt.hash(dto.password, 10);
      const superOwner = queryRunner.manager.create(Staff, {
        name: dto.ownerFullName,
        email: dto.email,
        passwordHash,
        role: StaffRole.SUPER_OWNER,
        isPlatformAdmin: false,
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

      // 8. Optional Store Manager
      if (dto.teamMode === 'with_team' && dto.storeManager?.email) {
        const mgrEmail = dto.storeManager.email.trim().toLowerCase();
        if (!dto.storeManager.password || dto.storeManager.password.length < 8) {
          throw new BadRequestException('Store manager needs a password of at least 8 characters');
        }
        const clash = await queryRunner.manager
          .createQueryBuilder(Staff, 's')
          .where('LOWER(s.email) = :email', { email: mgrEmail })
          .getOne();
        if (clash) {
          throw new BadRequestException('A user with the store manager email already exists');
        }
        const mgr = queryRunner.manager.create(Staff, {
          name: dto.storeManager.name || 'Store Manager',
          email: mgrEmail,
          passwordHash: await bcrypt.hash(dto.storeManager.password, 10),
          role: StaffRole.STORE_MANAGER,
          organizationId: savedOrg.id,
          restaurantId: savedOutlet.id,
        });
        await queryRunner.manager.save(Staff, mgr);
      }

      // 9. Kitchen station account (CHEF) owning the kitchen PIN, whatever the team mode
      if (dto.kitchenPin) {
        if (!/^\d{4,6}$/.test(dto.kitchenPin)) {
          throw new BadRequestException('Kitchen PIN must be 4 to 6 digits');
        }
        await queryRunner.manager.save(
          Staff,
          queryRunner.manager.create(Staff, {
            name: 'Kitchen Station',
            email: `kitchen.${savedOutlet.slug}@stations.pangat.app`,
            passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), // not usable for password login
            role: StaffRole.CHEF,
            organizationId: savedOrg.id,
            restaurantId: savedOutlet.id,
            pinHash: await bcrypt.hash(dto.kitchenPin, 10),
          }),
        );
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

  /**
   * Secure Password Reset: Generates a cryptographically secure, single-use expiring token.
   * Dispatches via configured transactional email provider if available.
   * Returns a neutral response to prevent account enumeration.
   */
  async requestPasswordReset(email: string): Promise<{ success: boolean; message: string }> {
    const cleanEmail = (email || '').trim().toLowerCase();
    const staff = await this.staffRepo
      .createQueryBuilder('s')
      .where('LOWER(s.email) = :email', { email: cleanEmail })
      .andWhere('s.is_active = true')
      .getOne();

    let deliveryProvider = 'none';

    if (staff) {
      // Cryptographically secure 32-byte hex token
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      // Store deterministic SHA-256 hash with 1 hour expiration
      staff.resetTokenHash = tokenHash;
      staff.resetTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await this.staffRepo.save(staff);

      // Build reset URL strictly from validated environment configuration (preventing Host header poisoning)
      const frontendBaseUrl =
        this.configService.get<string>('FRONTEND_URL')?.split(',')[0]?.trim() ||
        'https://layerform.in';
      const resetUrl = `${frontendBaseUrl}/login?resetToken=${rawToken}`;

      // Dispatch reset email with single-use raw token link
      const delivery = await this.emailDeliveryService.sendTransactionalEmail({
        to: staff.email,
        subject: 'Reset your Pangat password',
        htmlContent: `
          <div style="font-family: sans-serif; padding: 20px; color: #1e293b;">
            <h2>Namaskar ${staff.name},</h2>
            <p>A password reset was requested for your Pangat account.</p>
            <p>Please click the button below or copy the link into your browser to reset your password. This link is single-use and will expire in 60 minutes.</p>
            <p style="margin: 24px 0;">
              <a href="${resetUrl}" style="background-color: #059669; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
                Reset Password
              </a>
            </p>
            <p style="font-size: 12px; color: #64748b;">If you did not request this reset, you can safely ignore this email.</p>
          </div>
        `,
        textContent: `Namaskar ${staff.name},\n\nPlease use the following link to reset your Pangat password:\n${resetUrl}\n\nThis single-use link expires in 60 minutes.`,
      });
      deliveryProvider = delivery.provider;
      const isDelivered = Boolean(delivery.delivered);

      // Safe operational alerts without leaking tokens, reset links, recipient addresses, or secrets
      if (!isDelivered && deliveryProvider !== 'none') {
        this.logger.warn(`Password reset email delivery failed (Provider: ${deliveryProvider})`);
      } else if (isDelivered) {
        this.logger.log(`Password reset email accepted by provider (${deliveryProvider})`);
      }
    }

    // Accurate and neutral public response preventing account enumeration
    // Identical response whether or not the account exists (the provider/delivery state would leak that)
    void deliveryProvider;
    return {
      success: true,
      message: 'If the email exists, a password reset link has been dispatched.',
    };
  }

  /**
   * Finalize password reset using single-use expiring token.
   * Hashes incoming token with SHA-256 and searches directly for the matching record.
   * Invalidates token upon successful reset.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Valid reset token is required');
    }

    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');

    // Query specifically for the staff record holding this unexpired token hash
    const staff = await this.staffRepo.findOne({
      where: {
        resetTokenHash: tokenHash,
        resetTokenExpiresAt: MoreThan(new Date()),
      },
    });

    if (!staff) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    staff.passwordHash = await bcrypt.hash(newPassword, 10);
    staff.passwordChangedAt = new Date(); // signs out every existing session
    staff.failedLoginCount = 0;
    staff.lockedUntil = null;
    // Invalidate token immediately to prevent reuse
    staff.resetTokenHash = null;
    staff.resetTokenExpiresAt = null;
    await this.staffRepo.save(staff);

    return {
      success: true,
      message: 'Password has been updated successfully. You can now sign in.',
    };
  }
}
