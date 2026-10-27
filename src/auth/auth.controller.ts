import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { OnboardDto } from './dto/onboard.dto.js';
import { SetupSuperAdminDto } from './dto/setup-super-admin.dto.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('setup-super-admin')
  @HttpCode(HttpStatus.CREATED)
  async setupSuperAdmin(@Body() dto: SetupSuperAdminDto) {
    const result = await this.authService.setupPlatformAdmin(dto);
    return withMessage(result, 'Platform super admin provisioned successfully');
  }

  @Post('setup-platform-admin')
  @HttpCode(HttpStatus.CREATED)
  async setupPlatformAdmin(@Body() dto: SetupSuperAdminDto) {
    const result = await this.authService.setupPlatformAdmin(dto);
    return withMessage(result, 'Platform super admin provisioned successfully');
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto) {
    const result = await this.authService.login(loginDto);
    return withMessage(result, 'Authentication successful');
  }

  @Post('kds-pin-login')
  @HttpCode(HttpStatus.OK)
  async kdsPinLogin(@Body() dto: { pinCode: string; outletSlug?: string; station?: string }) {
    const result = await this.authService.kdsPinLogin(dto);
    return withMessage(result, 'Kitchen station authenticated successfully');
  }

  @Post('onboard')
  @HttpCode(HttpStatus.CREATED)
  async onboard(@Body() onboardDto: OnboardDto) {
    const result = await this.authService.onboard(onboardDto);
    return withMessage(
      result,
      'Organization, outlet, and tables provisioned successfully in atomic transaction',
    );
  }
}

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async onboard(@Body() onboardDto: OnboardDto) {
    const result = await this.authService.onboard(onboardDto);
    return withMessage(
      result,
      'Organization, outlet, and tables provisioned successfully in atomic transaction',
    );
  }
}
