import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MenuItem } from './entities/menu-item.entity.js';
import { MenuCategory } from './entities/menu-category.entity.js';
import { Modifier } from './entities/modifier.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { MenuService } from './menu.service.js';
import { MenuController } from './menu.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([MenuItem, MenuCategory, Modifier, Restaurant]),
  ],
  controllers: [MenuController],
  providers: [MenuService],
  exports: [MenuService],
})
export class MenuModule {}
