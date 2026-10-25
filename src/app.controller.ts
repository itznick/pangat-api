import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      service: 'pangat-api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('api/v1/health')
  getHealthV1() {
    return this.getHealth();
  }
}
