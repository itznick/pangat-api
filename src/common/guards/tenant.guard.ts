import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StaffRole } from '../enums/index.js';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { Order } from '../../orders/entities/order.entity.js';
import { Table } from '../../tables/entities/table.entity.js';
import { MenuItem } from '../../menu/entities/menu-item.entity.js';
import { MenuCategory } from '../../menu/entities/menu-category.entity.js';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    // Platform Super Admin bypasses single-tenant restriction
    if (user.isPlatformAdmin === true || user.role === StaffRole.PLATFORM_SUPER_ADMIN) {
      return true;
    }

    const { params, query, body } = request;

    // Resolve targeted restaurantId from any available context
    let targetRestaurantId: string | null = null;

    if (query?.restaurantId) {
      targetRestaurantId = query.restaurantId;
    } else if (body?.restaurantId) {
      targetRestaurantId = body.restaurantId;
    }

    // Resolve if restaurantSlug is provided
    const targetSlug = query?.restaurantSlug || body?.restaurantSlug || params?.slug || params?.restaurantSlug;
    if (!targetRestaurantId && targetSlug) {
      const cleanSlug = String(targetSlug).trim().toLowerCase();
      const restaurant = await this.dataSource.getRepository(Restaurant).findOne({
        where: [{ slug: cleanSlug }, { slug: targetSlug }],
      });
      if (!restaurant) {
        throw new NotFoundException(`Target restaurant '${targetSlug}' not found`);
      }
      targetRestaurantId = restaurant.id;
    }

    // Resolve if an entity ID is in params
    if (!targetRestaurantId && params?.id) {
      const entityId = params.id;
      // 1. Is it an order?
      const order = await this.dataSource.getRepository(Order).findOne({
        where: { id: entityId },
      });
      if (order) {
        targetRestaurantId = order.restaurantId;
      } else {
        // 2. Is it a table?
        const table = await this.dataSource.getRepository(Table).findOne({
          where: { id: entityId },
        });
        if (table) {
          targetRestaurantId = table.restaurantId;
        } else {
          // 3. Is it a menu item?
          const menuItem = await this.dataSource.getRepository(MenuItem).findOne({
            where: { id: entityId },
          });
          if (menuItem) {
            targetRestaurantId = menuItem.restaurantId;
          } else {
            // 4. Is it a category?
            const category = await this.dataSource.getRepository(MenuCategory).findOne({
              where: { id: entityId },
            });
            if (category) {
              targetRestaurantId = category.restaurantId;
            } else {
              // 5. Is it a restaurant ID?
              const rest = await this.dataSource.getRepository(Restaurant).findOne({
                where: { id: entityId },
              });
              if (rest) {
                targetRestaurantId = rest.id;
              }
            }
          }
        }
      }
    }

    // If no specific restaurant was referenced, and user has an assigned restaurant or organization, allow
    if (!targetRestaurantId) {
      return true;
    }

    // Now verify that the authenticated user is authorized for targetRestaurantId
    // If user has a specific restaurantId assigned (e.g. CHEF, CASHIER, STORE_MANAGER)
    if (user.restaurantId && user.restaurantId === targetRestaurantId) {
      return true;
    }

    // If user is SUPER_OWNER with organizationId, check if targetRestaurant belongs to their organization
    if (user.organizationId) {
      const targetRest = await this.dataSource.getRepository(Restaurant).findOne({
        where: { id: targetRestaurantId },
      });
      if (targetRest && targetRest.organizationId === user.organizationId) {
        return true;
      }
    }

    throw new ForbiddenException(
      'Access denied: You do not have permission to access or modify records for this restaurant',
    );
  }
}
