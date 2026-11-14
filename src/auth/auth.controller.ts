import {
  Controller,
  Post,
  Body,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { OnboardDto } from './dto/onboard.dto.js';
import { SetupSuperAdminDto } from './dto/setup-super-admin.dto.js';
import { RequestPasswordResetDto, ResetPasswordDto } from './dto/password-reset.dto.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters' })
  @MaxLength(128)
  newPassword: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('setup-super-admin')
  @HttpCode(HttpStatus.CREATED)
  async setupSuperAdmin(
    @Body() dto: SetupSuperAdminDto,
    @Headers('x-bootstrap-secret') bootstrapSecret?: string,
    @Req() req?: any,
  ) {
    const result = await this.authService.setupPlatformAdmin(dto, req?.user, bootstrapSecret);
    return withMessage(result, 'Platform super admin provisioned successfully');
  }

  @Post('setup-platform-admin')
  @HttpCode(HttpStatus.CREATED)
  async setupPlatformAdmin(
    @Body() dto: SetupSuperAdminDto,
    @Headers('x-bootstrap-secret') bootstrapSecret?: string,
    @Req() req?: any,
  ) {
    const result = await this.authService.setupPlatformAdmin(dto, req?.user, bootstrapSecret);
    return withMessage(result, 'Platform super admin provisioned successfully');
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto) {
    const result = await this.authService.login(loginDto);
    return withMessage(result, 'Authentication successful');
  }

  @Post('kds-pin-login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async kdsPinLogin(@Body() dto: { pinCode: string; outletSlug?: string; station?: string }, @Req() req?: any) {
    const result = await this.authService.kdsPinLogin(dto, req?.ip);
    return withMessage(result, 'Kitchen station authenticated successfully');
  }

  @Post('forgot-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: RequestPasswordResetDto) {
    const result = await this.authService.requestPasswordReset(dto.email);
    return withMessage(result, result.message);
  }

  @Post('reset-password')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    const result = await this.authService.resetPassword(dto.token, dto.newPassword);
    return withMessage(result, result.message);
  }

  @Post('onboard')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  async onboard(@Body() onboardDto: OnboardDto) {
    const result = await this.authService.onboard(onboardDto);
    return withMessage(
      result,
      'Organization, outlet, and tables provisioned successfully in atomic transaction',
    );
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: any) {
    return withMessage(await this.authService.me(req.user.id), 'Profile retrieved');
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  async updateMe(@Req() req: any, @Body() dto: UpdateProfileDto) {
    return withMessage(await this.authService.updateProfile(req.user.id, dto), 'Profile updated');
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    const r = await this.authService.changePassword(req.user.id, dto.currentPassword, dto.newPassword);
    return withMessage(r, r.message);
  }
}

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  async onboard(@Body() onboardDto: OnboardDto) {
    const result = await this.authService.onboard(onboardDto);
    return withMessage(
      result,
      'Organization, outlet, and tables provisioned successfully in atomic transaction',
    );
  }
}
