// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/entities/recipe-ingredient.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UnitOfMeasure } from '../../common/enums/index.js';
import { Recipe } from './recipe.entity.js';
import { Ingredient } from './ingredient.entity.js';
import { decimalTransformer } from '../../common/transformers/decimal.transformer.js';

@Entity('recipe_ingredients')
@Index(['recipeId'])
@Index(['ingredientId'])
export class RecipeIngredient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'recipe_id', type: 'uuid' })
  recipeId: string;

  @ManyToOne(() => Recipe, (recipe) => recipe.ingredients, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipe_id' })
  recipe: Recipe;

  @Column({ name: 'ingredient_id', type: 'uuid' })
  ingredientId: string;

  @ManyToOne(() => Ingredient, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ingredient_id' })
  ingredient: Ingredient;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 3,
    transformer: decimalTransformer,
  })
  quantity: number;

  @Column({
    type: 'enum',
    enum: UnitOfMeasure,
    default: UnitOfMeasure.KG,
  })
  unit: UnitOfMeasure;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
