import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Staff } from './entities/staff.entity.js';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  isPlatformAdmin?: boolean;
  organizationId: string | null;
  restaurantId: string | null;
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
      secretOrKey: configService.get<string>('JWT_SECRET') || 'super_secret_pangat_jwt_key_2026',
    });
  }

  async validate(payload: JwtPayload) {
    const staff = await this.staffRepo.findOne({ where: { id: payload.sub } });
    if (!staff) {
      throw new UnauthorizedException('User account no longer exists');
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
