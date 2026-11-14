import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { getOrgPlan, planHasFeature } from '../../subscriptions/subscription-access.js';
import { resolveFeatureAccess } from '../../platform/features.js';

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
    const decision = await resolveFeatureAccess(this.dataSource, orgId, feature, planHasFeature(plan, feature));
    if (!decision.allowed) {
      const label = feature.replace(/_/g, ' ').toLowerCase();
      throw new HttpException(
        decision.reason === 'PLAN'
          ? { message: `Your current plan does not include ${label}. Upgrade to unlock it.`, code: 'FEATURE_NOT_IN_PLAN', feature }
          : { message: `${label.charAt(0).toUpperCase()}${label.slice(1)} is currently unavailable for your account.`, code: 'FEATURE_DISABLED', feature },
        decision.reason === 'PLAN' ? HttpStatus.PAYMENT_REQUIRED : HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
