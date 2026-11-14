import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { resolveJwtSecret } from '../common/security/secrets.js';
import { Staff } from './entities/staff.entity.js';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  isPlatformAdmin?: boolean;
  organizationId: string | null;
  restaurantId: string | null;
  iat?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectRepository(Staff)
    private readonly staffRepo: Repository<Staff>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: resolveJwtSecret(configService.get<string>('JWT_SECRET')),
    });
  }

  async validate(payload: JwtPayload) {
    const staff = await this.staffRepo.findOne({ where: { id: payload.sub } });
    if (!staff) {
      throw new UnauthorizedException('User account no longer exists');
    }
    if (staff.isActive === false) {
      throw new UnauthorizedException('This account has been deactivated');
    }
    // A password change / reset invalidates every token issued before it
    if (staff.passwordChangedAt && payload.iat && payload.iat < Math.floor(staff.passwordChangedAt.getTime() / 1000)) {
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }
    return {
      id: staff.id,
      name: staff.name,
      email: staff.email,
      role: staff.role,
      isPlatformAdmin: Boolean(staff.isPlatformAdmin || staff.role === 'PLATFORM_SUPER_ADMIN'),
      organizationId: staff.organizationId,
      restaurantId: staff.restaurantId,
    };
  }
}
