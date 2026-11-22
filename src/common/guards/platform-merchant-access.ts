import { ForbiddenException } from '@nestjs/common';

/**
 * Platform staff reaching INTO a restaurant's own console (orders, customers, menu...).
 *  - reading needs `merchant.view` (or `merchant.operate`)
 *  - changing anything needs `merchant.operate`
 * Having some other platform permission (analytics, billing, support tickets) is deliberately not enough: customer
 * names, phone numbers and addresses are personal data and only roles that need them may open them.
 */
export function assertPlatformMerchantAccess(user: { platformPermissions?: string[] }, method: string): void {
  const perms = user.platformPermissions || [];
  const m = String(method || 'GET').toUpperCase();
  const read = m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
  if (read) {
    if (!perms.includes('merchant.view') && !perms.includes('merchant.operate')) {
      throw new ForbiddenException('Access denied: your platform role cannot open restaurant consoles. Ask an owner for the "view restaurant consoles" permission.');
    }
    return;
  }
  if (!perms.includes('merchant.operate')) {
    throw new ForbiddenException('Access denied: your platform role is read-only inside restaurant consoles');
  }
}
