import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { getOrgPlan, planHasFeature } from '../../subscriptions/subscription-access.js';

export const FEATURE_KEY = 'plan_feature';
/** Restrict a controller / route to organizations whose subscription plan includes this feature. */
export const RequireFeature = (feature: string) => SetMetadata(FEATURE_KEY, feature);

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<string>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!feature) return true;
    const user = context.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException('Authentication required');
    if (user.isPlatformAdmin || user.role === 'PLATFORM_SUPER_ADMIN') return true;

    let orgId: string | null = user.organizationId ?? null;
    if (!orgId && user.restaurantId) {
      orgId = (await this.dataSource.getRepository(Restaurant).findOne({ where: { id: user.restaurantId } }))?.organizationId ?? null;
    }
    if (!orgId) return true;
    const plan = await getOrgPlan(this.dataSource, orgId);
    if (!planHasFeature(plan, feature)) {
      throw new HttpException(
        { message: `Your current plan does not include ${feature.replace(/_/g, ' ').toLowerCase()}. Upgrade to unlock it.`, code: 'FEATURE_NOT_IN_PLAN', feature },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}
