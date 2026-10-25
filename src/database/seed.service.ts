import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { MenuCategory } from '../menu/entities/menu-category.entity.js';
import { MenuItem } from '../menu/entities/menu-item.entity.js';
import { Modifier } from '../menu/entities/modifier.entity.js';
import { Staff, StaffRole } from '../auth/entities/staff.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { OrderItem } from '../orders/entities/order-item.entity.js';
import {
  TableStatus,
  ModifierType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../common/enums/index.js';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    @InjectRepository(Table)
    private readonly tableRepo: Repository<Table>,
    @InjectRepository(MenuCategory)
    private readonly categoryRepo: Repository<MenuCategory>,
    @InjectRepository(MenuItem)
    private readonly menuItemRepo: Repository<MenuItem>,
    @InjectRepository(Modifier)
    private readonly modifierRepo: Repository<Modifier>,
    @InjectRepository(Staff)
    private readonly staffRepo: Repository<Staff>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepo: Repository<OrderItem>,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.seed();
    } catch (err: any) {
      this.logger.warn(`Database seeding skipped or encountered error: ${err.message}`);
    }
  }

  async seed() {
    // 1. Restaurant
    let restaurant = await this.restaurantRepo.findOne({
      where: { slug: 'pangat' },
    });

    if (!restaurant) {
      this.logger.log('Seeding initial restaurant "The Pangat"...');
      restaurant = this.restaurantRepo.create({
        name: 'The Pangat',
        slug: 'pangat',
        upiVpa: 'pangat.bandra@icici',
        gstin: '27AADCB2230M1ZT',
        hsnSac: '9963',
        gstPercentage: 5.0,
        isVegOnly: false,
        kdsNewOrderAlert: true,
        orderReadyChime: true,
        outOfStockNotification: true,
      });
      restaurant = await this.restaurantRepo.save(restaurant);
    }

    // 2. Owner Staff account (Rohan Kamble)
    const existingStaff = await this.staffRepo.findOne({
      where: { email: 'owner@pangat.com' },
    });

    if (!existingStaff) {
      this.logger.log('Seeding owner staff account (Rohan Kamble)...');
      const passwordHash = await bcrypt.hash('pangat123', 10);
      const staff = this.staffRepo.create({
        name: 'Rohan Kamble',
        email: 'owner@pangat.com',
        passwordHash,
        role: StaffRole.OWNER,
        restaurantId: restaurant.id,
      });
      await this.staffRepo.save(staff);
    }

    // 3. Tables (01 to 12)
    const existingTablesCount = await this.tableRepo.count({
      where: { restaurantId: restaurant.id },
    });

    if (existingTablesCount === 0) {
      this.logger.log('Seeding 12 floor tables...');
      const tableSeed: { number: string; status: TableStatus }[] = [
        { number: '01', status: TableStatus.OCCUPIED },
        { number: '02', status: TableStatus.SERVED },
        { number: '03', status: TableStatus.VACANT },
        { number: '04', status: TableStatus.OCCUPIED },
        { number: '05', status: TableStatus.VACANT },
        { number: '06', status: TableStatus.PREPPING },
        { number: '07', status: TableStatus.OCCUPIED },
        { number: '08', status: TableStatus.VACANT },
        { number: '09', status: TableStatus.SERVED },
        { number: '10', status: TableStatus.OCCUPIED },
        { number: '11', status: TableStatus.PREPPING },
        { number: '12', status: TableStatus.VACANT },
      ];

      for (const t of tableSeed) {
        const table = this.tableRepo.create({
          restaurantId: restaurant.id,
          tableNumber: t.number,
          qrCodeUrl: `/qr/t${t.number}.png`,
          status: t.status,
        });
        await this.tableRepo.save(table);
      }
    }

    // 4. Categories & Menu Items
    const existingCategoriesCount = await this.categoryRepo.count({
      where: { restaurantId: restaurant.id },
    });

    if (existingCategoriesCount === 0) {
      this.logger.log('Seeding menu categories and authentic Indian dishes...');

      const catNashta = await this.categoryRepo.save(
        this.categoryRepo.create({
          restaurantId: restaurant.id,
          name: 'All Day Nashta & Meals',
          sortOrder: 1,
        }),
      );

      const catChaat = await this.categoryRepo.save(
        this.categoryRepo.create({
          restaurantId: restaurant.id,
          name: 'Street Chaat & Starters',
          sortOrder: 2,
        }),
      );

      const catBeverages = await this.categoryRepo.save(
        this.categoryRepo.create({
          restaurantId: restaurant.id,
          name: 'Chai, Coffee & Coolers',
          sortOrder: 3,
        }),
      );

      const catDessert = await this.categoryRepo.save(
        this.categoryRepo.create({
          restaurantId: restaurant.id,
          name: 'Mithai & Desserts',
          sortOrder: 4,
        }),
      );

      // ── Nashta items
      const misal = await this.menuItemRepo.save(
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catNashta.id,
          name: 'Puneri Misal Pav',
          description:
            'Spicy sprouted moth bean curry, crunchy farsan, diced onions, fresh coriander, 2 buttered pav & lemon wedge.',
          price: 140,
          isVeg: true,
          isAvailable: true,
          isPopular: true,
          imageUrl: '🍲',
        }),
      );

      await this.modifierRepo.save([
        this.modifierRepo.create({
          menuItemId: misal.id,
          name: 'Spice Level',
          type: ModifierType.SINGLE,
          isRequired: true,
          options: [
            { name: 'Medium Spicy', price: 0 },
            { name: 'Kolhapuri Tikhat (Hot)', price: 0 },
            { name: 'Mild (Low Chilli)', price: 0 },
          ],
        }),
        this.modifierRepo.create({
          menuItemId: misal.id,
          name: 'Add-ons',
          type: ModifierType.MULTIPLE,
          isRequired: false,
          options: [
            { name: 'Extra Pav Pair (2 pcs)', price: 25 },
            { name: 'Extra Rassa / Kat Bowl', price: 20 },
            { name: 'Fresh Dahi / Curd Bowl', price: 20 },
          ],
        }),
      ]);

      const dosa = await this.menuItemRepo.save(
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catNashta.id,
          name: 'Mysore Masala Dosa',
          description:
            'Crisp golden fermented crepe smeared with spicy red garlic-chilli chutney, spiced potato bhaji, fresh coconut chutney & piping hot sambar.',
          price: 160,
          isVeg: true,
          isAvailable: true,
          isPopular: true,
          imageUrl: '🥞',
        }),
      );

      await this.modifierRepo.save([
        this.modifierRepo.create({
          menuItemId: dosa.id,
          name: 'Preparation Style',
          type: ModifierType.SINGLE,
          isRequired: true,
          options: [
            { name: 'Amul Butter', price: 0 },
            { name: 'Desi Cow Ghee', price: 25 },
          ],
        }),
        this.modifierRepo.create({
          menuItemId: dosa.id,
          name: 'Add-ons',
          type: ModifierType.MULTIPLE,
          isRequired: false,
          options: [
            { name: 'Gunpowder Podi Dusting', price: 20 },
            { name: 'Grated Amul Cheese', price: 30 },
          ],
        }),
      ]);

      await this.menuItemRepo.save([
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catNashta.id,
          name: 'Kanda Poha & Cutting Chai',
          description:
            'Flattened rice tempered with mustard, roasted peanuts, green chillies and curry leaves, topped with nylon sev, served with hot cutting chai.',
          price: 110,
          isVeg: true,
          isAvailable: true,
          imageUrl: '🍛',
        }),
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catNashta.id,
          name: 'Bun Maska & Irani Chai',
          description:
            'Warm soft bakery bun generously slathered with whipped salted butter, paired with slow-brewed caramelised milky Irani chai.',
          price: 95,
          isVeg: true,
          isAvailable: true,
          isPopular: true,
          imageUrl: '🥯',
        }),
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catNashta.id,
          name: 'Paneer Bhurji & Malabar Paratha',
          description:
            'Fresh crumbly cottage cheese scrambled with tomatoes, onions, crushed ginger and fragrant kasuri methi, paired with 2 flaky Malabar parathas.',
          price: 210,
          isVeg: true,
          isAvailable: true,
          imageUrl: '🥘',
        }),
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catNashta.id,
          name: 'Kolhapuri Keema Pav',
          description:
            'Slow-braised spiced minced mutton in fragrant hand-pounded Kolhapuri masala, fresh mint and lime, served with 2 toasted pav.',
          price: 260,
          isVeg: false,
          isAvailable: true,
          isPopular: true,
          imageUrl: '🍖',
        }),
      ]);

      // ── Chaat items
      await this.menuItemRepo.save([
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catChaat.id,
          name: 'Amritsari Paneer Tikka',
          description:
            'Thick cubes of fresh Malai paneer marinated in roasted gram flour, carom seeds and mustard oil, char-grilled in tandoor. Served with mint chutney.',
          price: 240,
          isVeg: true,
          isAvailable: true,
          isPopular: true,
          imageUrl: '🍢',
        }),
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catChaat.id,
          name: 'Butter Chicken Kathi Roll',
          description:
            'Tender char-grilled chicken morsels tossed in velvety makhani sauce, rolled with crunchy spiced onions in a crisp handmade paratha.',
          price: 220,
          isVeg: false,
          isAvailable: true,
          isPopular: true,
          imageUrl: '🌯',
        }),
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catChaat.id,
          name: 'Dahi Puri Chaat',
          description:
            'Crisp golden puris filled with spiced potato cubes, chilled sweet curd, date-tamarind chutney, spicy mint pani and fine nylon sev.',
          price: 130,
          isVeg: true,
          isAvailable: true,
          imageUrl: '🥙',
        }),
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catChaat.id,
          name: 'Vada Pav Fondue',
          description:
            'Signature Pangat creation: crispy mini spiced potato vadas on bamboo skewers, served with bubbling cheese fondue and garlic dry thecha.',
          price: 175,
          isVeg: true,
          isAvailable: false,
          imageUrl: '🧀',
        }),
      ]);

      // ── Beverages
      await this.menuItemRepo.save([
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catBeverages.id,
          name: 'South Indian Degree Filter Coffee',
          description:
            'Authentic Plantation AA chicory blend slow-dripped in brass filter, frothed with hot creamy milk, served in traditional brass davarah.',
          price: 80,
          isVeg: true,
          isAvailable: true,
          isPopular: true,
          imageUrl: '☕',
        }),
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catBeverages.id,
          name: 'Cutting Masala Chai',
          description:
            'Strong boiled CTC tea infused with crushed green cardamom, dried ginger, cloves and fresh lemongrass.',
          price: 50,
          isVeg: true,
          isAvailable: true,
          imageUrl: '🍵',
        }),
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catBeverages.id,
          name: 'Kokum Jeera Cooler',
          description:
            'Refreshing Konkani wild mangosteen extract infused with roasted cumin powder, black salt, fresh mint leaves and sparkling soda.',
          price: 90,
          isVeg: true,
          isAvailable: true,
          imageUrl: '🍹',
        }),
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catBeverages.id,
          name: 'Kesar Pista Lassi',
          description:
            'Hand-churned creamy thick yoghurt sweetened with desi khand, topped with Kashmiri saffron strands, chopped pistachios and cardamom dust.',
          price: 120,
          isVeg: true,
          isAvailable: true,
          imageUrl: '🥛',
        }),
      ]);

      // ── Desserts
      await this.menuItemRepo.save([
        this.menuItemRepo.create({
          restaurantId: restaurant.id,
          categoryId: catDessert.id,
          name: 'Gulab Jamun with Malai Rabdi',
          description:
            'Warm soft khoya dumplings soaked in fragrant cardamom-rose syrup, served over a bed of slow-cooked saffron malai rabdi.',
          price: 130,
          isVeg: true,
          isAvailable: true,
          isPopular: true,
          imageUrl: '🍨',
        }),
      ]);
    }

    // 5. Initial Seed Orders
    const existingOrdersCount = await this.orderRepo.count({
      where: { restaurantId: restaurant.id },
    });

    if (existingOrdersCount === 0) {
      this.logger.log('Seeding initial orders...');
      const order1 = this.orderRepo.create({
        id: 'order-001',
        restaurantId: restaurant.id,
        tableNumber: '04',
        orderStatus: OrderStatus.RECEIVED,
        paymentStatus: PaymentStatus.PENDING,
        paymentMethod: PaymentMethod.PAY_AT_COUNTER,
        customerPhone: '9820098200',
        subtotal: 300,
        gstAmount: 15,
        totalAmount: 315,
        idempotencyKey: 'seed-idemp-001',
      });
      const savedO1 = await this.orderRepo.save(order1);
      await this.orderItemRepo.save([
        this.orderItemRepo.create({
          orderId: savedO1.id,
          name: 'Puneri Misal Pav',
          price: 140,
          quantity: 1,
          selectedModifiers: [
            { name: 'Kolhapuri Tikhat (Hot)', price: 0 },
            { name: 'Extra Pav Pair (2 pcs)', price: 25 },
          ],
          notes: 'Extra rassa hot please',
        }),
        this.orderItemRepo.create({
          orderId: savedO1.id,
          name: 'South Indian Degree Filter Coffee',
          price: 80,
          quantity: 2,
          selectedModifiers: [{ name: 'Less Sugar', price: 0 }],
        }),
      ]);

      const order2 = this.orderRepo.create({
        id: 'order-002',
        restaurantId: restaurant.id,
        tableNumber: '07',
        orderStatus: OrderStatus.PREPARING,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.UPI_INSTANT,
        customerPhone: '9876543210',
        subtotal: 410,
        gstAmount: 20.5,
        totalAmount: 430.5,
        idempotencyKey: 'seed-idemp-002',
      });
      const savedO2 = await this.orderRepo.save(order2);
      await this.orderItemRepo.save([
        this.orderItemRepo.create({
          orderId: savedO2.id,
          name: 'Mysore Masala Dosa',
          price: 160,
          quantity: 2,
          selectedModifiers: [
            { name: 'Desi Cow Ghee', price: 25 },
            { name: 'Gunpowder Podi Dusting', price: 20 },
          ],
          notes: 'Make it extra crisp',
        }),
        this.orderItemRepo.create({
          orderId: savedO2.id,
          name: 'Kokum Jeera Cooler',
          price: 90,
          quantity: 1,
          selectedModifiers: [],
        }),
      ]);
    }

    this.logger.log('Database seeding complete ✅');
  }
}
