import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
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

    // Fail closed: Request must be authenticated
    if (!user) {
      throw new ForbiddenException('Access denied: Unauthenticated request');
    }

    // Platform Super Admin bypasses tenant scoping
    if (user.isPlatformAdmin === true || user.role === StaffRole.PLATFORM_SUPER_ADMIN) {
      return true;
    }

    const { params, query, body } = request;

    // Resolve explicit resource identifier from route parameters
    const explicitEntityId =
      params?.orderId ||
      params?.tableId ||
      params?.menuItemId ||
      params?.categoryId ||
      params?.id;

    let targetRestaurantId: string | null = null;

    // 1. If a resource ID is present in route params, ALWAYS resolve authorization
    // based on the actual database resource being accessed.
    if (explicitEntityId) {
      const entityId = String(explicitEntityId).trim();

      // Check Order
      const order = await this.dataSource.getRepository(Order).findOne({
        where: { id: entityId },
      });
      if (order) {
        targetRestaurantId = order.restaurantId;
      } else {
        // Check Table
        const table = await this.dataSource.getRepository(Table).findOne({
          where: { id: entityId },
        });
        if (table) {
          targetRestaurantId = table.restaurantId;
        } else {
          // Check MenuItem
          const menuItem = await this.dataSource.getRepository(MenuItem).findOne({
            where: { id: entityId },
          });
          if (menuItem) {
            targetRestaurantId = menuItem.restaurantId;
          } else {
            // Check MenuCategory
            const category = await this.dataSource.getRepository(MenuCategory).findOne({
              where: { id: entityId },
            });
            if (category) {
              targetRestaurantId = category.restaurantId;
            } else {
              // Check Restaurant itself
              const rest = await this.dataSource.getRepository(Restaurant).findOne({
                where: { id: entityId },
              });
              if (rest) {
                targetRestaurantId = rest.id;
              } else {
                // If resource does not exist, fail with non-disclosing 404
                throw new NotFoundException(`Resource with ID '${entityId}' not found`);
              }
            }
          }
        }
      }

      // Check for conflict: If client supplied a conflicting restaurantId in query or body,
      // strictly reject to prevent cross-tenant parameter spoofing.
      const clientSuppliedRestaurantId = query?.restaurantId || body?.restaurantId;
      if (
        clientSuppliedRestaurantId &&
        String(clientSuppliedRestaurantId).trim() !== targetRestaurantId
      ) {
        throw new ForbiddenException(
          'Tenant conflict: Target resource does not belong to the specified restaurant',
        );
      }

      const clientSuppliedSlug =
        query?.restaurantSlug || body?.restaurantSlug || params?.slug || params?.restaurantSlug;
      if (clientSuppliedSlug) {
        const cleanSlug = String(clientSuppliedSlug).trim().toLowerCase();
        const slugRest = await this.dataSource.getRepository(Restaurant).findOne({
          where: [{ slug: cleanSlug }, { slug: String(clientSuppliedSlug).trim() }],
        });
        if (slugRest && slugRest.id !== targetRestaurantId) {
          throw new ForbiddenException(
            'Tenant conflict: Target resource does not belong to the specified restaurant',
          );
        }
      }
    } else {
      // 2. No route resource ID (e.g. collection listings, create operations)
      if (query?.restaurantId) {
        targetRestaurantId = String(query.restaurantId).trim();
      } else if (body?.restaurantId) {
        targetRestaurantId = String(body.restaurantId).trim();
      }

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
    }

    // STRICT FAIL-CLOSED: Target restaurant must be definitively resolved
    if (!targetRestaurantId) {
      throw new ForbiddenException(
        'Access denied: Target restaurant context is required for this operation',
      );
    }

    // Verify authorized access to targetRestaurantId:
    // Staff (CHEF, CASHIER, STORE_MANAGER, STEWARD) strictly limited to their assigned restaurant
    if (user.restaurantId && user.restaurantId === targetRestaurantId) {
      return true;
    }

    // Organization Super Owner (SUPER_OWNER) can access any outlet in their organization
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
      'Access denied: You do not have permission to access records for this restaurant',
    );
  }
}
