import { ValueTransformer } from 'typeorm';

export class DecimalTransformer implements ValueTransformer {
  to(data?: number | null): number | null | undefined {
    if (data === undefined) return undefined;
    if (data === null) return null;
    return Number(data);
  }

  from(data?: string | number | null): number {
    if (data === null || data === undefined) return 0;
    const parsed = typeof data === 'number' ? data : parseFloat(data);
    return isNaN(parsed) ? 0 : parsed;
  }
}

export const decimalTransformer = new DecimalTransformer();
