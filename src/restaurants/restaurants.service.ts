import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Restaurant } from './entities/restaurant.entity.js';
import { Staff } from '../auth/entities/staff.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';

@Injectable()
export class RestaurantsService {
  constructor(
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    @InjectRepository(Staff)
    private readonly staffRepo: Repository<Staff>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
  ) {}

  async findBySlug(slug: string): Promise<Restaurant> {
    const cleanSlug = slug.trim().toLowerCase();
    const restaurant = await this.restaurantRepo.findOne({
      where: [{ slug: cleanSlug }, { slug }],
      relations: { tables: true },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant with slug '${slug}' not found`);
    }

    return restaurant;
  }

  async getFeedback(slug: string) {
    const restaurant = await this.findBySlug(slug);

    // Fetch orders with recorded feedback
    const ordersWithFeedback = await this.orderRepo
      .createQueryBuilder('order')
      .where('order.restaurantId = :restId', { restId: restaurant.id })
      .andWhere("order.feedback IS NOT NULL")
      .orderBy('order.createdAt', 'DESC')
      .take(50)
      .getMany();

    const actualReviews = ordersWithFeedback
      .filter((o) => o.feedback && o.feedback.rating)
      .map((o) => ({
        id: `fb-${o.id}`,
        orderId: o.id,
        tableNumber: o.tableNumber || '01',
        rating: Number(o.feedback?.rating) || 5,
        tags: o.feedback?.tags || [],
        comment: o.feedback?.comment || undefined,
        createdAt: o.feedback?.submittedAt || o.createdAt,
      }));

    const ratingBreakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const tagCounts: Record<string, number> = {};

    let totalRatingSum = 0;
    for (const r of actualReviews) {
      const star = Math.min(5, Math.max(1, Math.round(r.rating)));
      ratingBreakdown[star] = (ratingBreakdown[star] || 0) + 1;
      totalRatingSum += r.rating;

      if (Array.isArray(r.tags)) {
        for (const t of r.tags) {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        }
      }
    }

    const totalCount = actualReviews.length;
    const averageRating = totalCount > 0 ? Number((totalRatingSum / totalCount).toFixed(1)) : 0;

    return {
      restaurantSlug: restaurant.slug,
      restaurantName: restaurant.name,
      averageRating,
      totalCount,
      ratingBreakdown,
      tagCounts,
      recentReviews: actualReviews.slice(0, 50),
    };
  }

  async submitFeedback(
    slug: string,
    dto: { orderId?: string; tableNumber?: string; rating: number; tags?: string[]; comment?: string },
  ) {
    const restaurant = await this.findBySlug(slug);

    if (dto.orderId) {
      const order = await this.orderRepo.findOne({
        where: { id: dto.orderId, restaurantId: restaurant.id },
      });
      if (order) {
        order.feedback = {
          rating: Number(dto.rating) || 5,
          tags: Array.isArray(dto.tags) ? dto.tags : [],
          comment: dto.comment?.trim() || undefined,
          submittedAt: new Date().toISOString(),
        };
        await this.orderRepo.save(order);
        return { success: true, orderId: order.id, feedback: order.feedback };
      }
    }

    return {
      success: true,
      feedback: {
        rating: Number(dto.rating) || 5,
        tags: Array.isArray(dto.tags) ? dto.tags : [],
        comment: dto.comment?.trim() || undefined,
        submittedAt: new Date().toISOString(),
      },
    };
  }

  async updateSettings(slug: string, dto: UpdateSettingsDto): Promise<Restaurant> {
    const restaurant = await this.findBySlug(slug);

    Object.assign(restaurant, dto);
    return this.restaurantRepo.save(restaurant);
  }

  async createStaff(restaurantId: string, dto: CreateStaffDto) {
    const restaurant = await this.restaurantRepo.findOne({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant with ID '${restaurantId}' not found`);
    }

    const existing = await this.staffRepo.findOne({
      where: { email: dto.email },
    });

    if (existing) {
      throw new BadRequestException('A user with this email address already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password || 'pangat123', 10);
    const staff = this.staffRepo.create({
      name: dto.name,
      email: dto.email,
      passwordHash,
      role: dto.role,
      organizationId: restaurant.organizationId,
      restaurantId: restaurant.id,
      pinCode: dto.pinCode || null,
    });

    const saved = await this.staffRepo.save(staff);
    const { passwordHash: _, ...cleanStaff } = saved;
    return cleanStaff;
  }
}
