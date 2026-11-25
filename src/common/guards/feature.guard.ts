import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { decideFeature, featureError } from '../../subscriptions/subscription-access.js';

export const FEATURE_KEY = 'plan_feature';
export interface FeatureRule {
  feature: string;
  /** When set, the rule only applies to callers with one of these roles (e.g. the kitchen role needs KDS, the owner's order screen does not). */
  forRoles?: string[];
}
/**
 * Restrict a controller / route to organizations whose subscription plan includes this feature.
 * The decision (plan + platform kill switch + per-organisation override) is `decideFeature`, shared with every other enforcement point.
 */
export const RequireFeature = (feature: string, options?: { forRoles?: string[] }) =>
  SetMetadata(FEATURE_KEY, { feature, forRoles: options?.forRoles } as FeatureRule);

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const raw = this.reflector.getAllAndOverride<FeatureRule | string>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!raw) return true;
    const rule: FeatureRule = typeof raw === 'string' ? { feature: raw } : raw;
    const user = context.switchToHttp().getRequest().user;
    if (!user) throw new ForbiddenException('Authentication required');
    if (user.isPlatformAdmin || user.role === 'PLATFORM_SUPER_ADMIN') return true;
    if (rule.forRoles && !rule.forRoles.includes(user.role)) return true;

    let orgId: string | null = user.organizationId ?? null;
    if (!orgId && user.restaurantId) {
      orgId = (await this.dataSource.getRepository(Restaurant).findOne({ where: { id: user.restaurantId } }))?.organizationId ?? null;
    }
    if (!orgId) return true;
    const decision = await decideFeature(this.dataSource, orgId, rule.feature);
    if (!decision.allowed) throw featureError(rule.feature, decision.reason);
    return true;
  }
}
