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

    // Platform Super Admin bypasses single-tenant restriction explicitly
    if (user.isPlatformAdmin === true || user.role === StaffRole.PLATFORM_SUPER_ADMIN) {
      return true;
    }

    const { params, query, body } = request;

    // Resolve targeted restaurantId from request context
    let targetRestaurantId: string | null = null;

    if (query?.restaurantId) {
      targetRestaurantId = String(query.restaurantId).trim();
    } else if (body?.restaurantId) {
      targetRestaurantId = String(body.restaurantId).trim();
    }

    // Resolve target restaurant by slug if provided
    const targetSlug =
      query?.restaurantSlug ||
      body?.restaurantSlug ||
      params?.slug ||
      params?.restaurantSlug;

    if (!targetRestaurantId && targetSlug) {
      const cleanSlug = String(targetSlug).trim().toLowerCase();
      const restaurant = await this.dataSource.getRepository(Restaurant).findOne({
        where: [{ slug: cleanSlug }, { slug: String(targetSlug).trim() }],
      });
      if (!restaurant) {
        throw new NotFoundException(`Target restaurant '${targetSlug}' not found`);
      }
      targetRestaurantId = restaurant.id;
    }

    // Resolve explicit route parameters: :orderId, :tableId, :menuItemId, :categoryId, :id
    const explicitEntityId =
      params?.orderId ||
      params?.tableId ||
      params?.menuItemId ||
      params?.categoryId ||
      params?.id;

    if (!targetRestaurantId && explicitEntityId) {
      const entityId = String(explicitEntityId).trim();

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
              } else {
                // If an ID was given but no matching entity exists in the system, fail closed
                throw new NotFoundException(`Resource with ID '${entityId}' not found`);
              }
            }
          }
        }
      }
    }

    // STRICT FAIL-CLOSED ENFORCEMENT:
    // If the request contains no explicit target restaurant or target entity reference,
    // it is REJECTED with HTTP 403 Forbidden.
    // There is no blanket return true or silent bypass.
    if (!targetRestaurantId) {
      throw new ForbiddenException(
        'Access denied: Target restaurant context is required for this operation',
      );
    }

    // Verify authorized access to targetRestaurantId:
    // 1. Assigned staff (CHEF, CASHIER, STORE_MANAGER) strictly limited to their restaurant
    if (user.restaurantId && user.restaurantId === targetRestaurantId) {
      return true;
    }

    // 2. Organization Super Owner (SUPER_OWNER) can access any outlet in their organization
    if (user.organizationId) {
      const targetRest = await this.dataSource.getRepository(Restaurant).findOne({
        where: { id: targetRestaurantId },
      });
      if (targetRest && targetRest.organizationId === user.organizationId) {
        return true;
      }
    }

    // Fail closed with 403 Forbidden
    throw new ForbiddenException(
      'Access denied: You do not have permission to access or modify records for this restaurant',
    );
  }
}
