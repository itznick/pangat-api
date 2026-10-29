import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Staff } from './entities/staff.entity.js';
import { Organization } from '../organizations/entities/organization.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { MenuCategory } from '../menu/entities/menu-category.entity.js';
import { MenuItem } from '../menu/entities/menu-item.entity.js';
import { AuthService } from './auth.service.js';
import { AuthController, OnboardingController } from './auth.controller.js';
import { JwtStrategy } from './jwt.strategy.js';
import { EmailDeliveryService } from '../common/services/email-delivery.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Staff,
      Organization,
      Restaurant,
      Table,
      MenuCategory,
      MenuItem,
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') || 'super_secret_pangat_jwt_key_2026',
        signOptions: {
          expiresIn: (config.get<string>('JWT_EXPIRATION') || '7d') as any,
        },
      }),
    }),
  ],
  controllers: [AuthController, OnboardingController],
  providers: [AuthService, JwtStrategy, EmailDeliveryService],
  exports: [AuthService, JwtStrategy, PassportModule, EmailDeliveryService],
})
export class AuthModule {}
