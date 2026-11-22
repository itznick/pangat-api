// Platform (Super Admin) permission catalogue and role presets. Enforced on the server by PlatformAdminGuard.

export const PERMISSION_CATALOG: { key: string; label: string; group: string }[] = [
  { key: 'dashboard.view', label: 'View platform dashboard', group: 'Overview' },
  { key: 'restaurants.view', label: 'View restaurants & outlets', group: 'Restaurants' },
  { key: 'restaurants.manage', label: 'Suspend / restore, verify, add notes', group: 'Restaurants' },
  { key: 'restaurants.provision', label: 'Provision new restaurants', group: 'Restaurants' },
  { key: 'subscriptions.view', label: 'View subscriptions & plans', group: 'Billing' },
  { key: 'subscriptions.manage', label: 'Assign, extend, change or cancel subscriptions', group: 'Billing' },
  { key: 'plans.manage', label: 'Create and edit plans', group: 'Billing' },
  { key: 'payments.view', label: 'View payments & reconciliation', group: 'Billing' },
  { key: 'payments.export', label: 'Download financial reports', group: 'Billing' },
  { key: 'users.view', label: 'View platform users', group: 'People' },
  { key: 'users.manage', label: 'Activate, lock, sign out, reset passwords', group: 'People' },
  { key: 'admins.manage', label: 'Manage platform administrators & roles', group: 'People' },
  { key: 'leads.manage', label: 'Manage inbound leads', group: 'Growth' },
  { key: 'notifications.view', label: 'View communications history', group: 'Communication' },
  { key: 'notifications.send', label: 'Send announcements & notifications', group: 'Communication' },
  { key: 'support.view', label: 'View support tickets', group: 'Support' },
  { key: 'support.manage', label: 'Triage, assign and resolve tickets', group: 'Support' },
  { key: 'monitoring.view', label: 'View system health & logs', group: 'Platform' },
  { key: 'audit.view', label: 'View audit log', group: 'Platform' },
  { key: 'settings.view', label: 'View platform settings', group: 'Platform' },
  { key: 'settings.manage', label: 'Change settings, feature access & maintenance', group: 'Platform' },
  { key: 'exports.manage', label: 'Export restaurant data', group: 'Platform' },
  { key: 'privacy.view', label: 'View privacy requests & consent records', group: 'Compliance' },
  { key: 'privacy.manage', label: 'Handle privacy requests (access, correction, erasure, grievances)', group: 'Compliance' },
  { key: 'merchant.view', label: 'Open restaurant consoles (sees customer details)', group: 'Platform' },
  { key: 'merchant.operate', label: 'Make changes inside a restaurant console', group: 'Platform' },
];

export const ALL_PERMISSIONS = PERMISSION_CATALOG.map((p) => p.key);
// Read-only roles get exactly what the job needs. Audit, settings, monitoring and the user directory are
// deliberately NOT in the analyst preset: they expose people's details and security evidence.
const ANALYST_VIEWS = ['dashboard.view', 'restaurants.view', 'subscriptions.view', 'payments.view'];

export const PLATFORM_ROLES: Record<string, { label: string; description: string; permissions: string[] }> = {
  OWNER: { label: 'Owner', description: 'Full control, including administrators and settings', permissions: ALL_PERMISSIONS },
  ADMIN: {
    label: 'Administrator',
    description: 'Runs the platform day to day; cannot manage other administrators',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'admins.manage'),
  },
  FINANCE: {
    label: 'Finance',
    description: 'Billing, subscriptions and financial reports',
    permissions: ['dashboard.view', 'restaurants.view', 'subscriptions.view', 'subscriptions.manage', 'payments.view', 'payments.export'],
  },
  SUPPORT: {
    label: 'Support',
    description: 'Helps restaurants: tickets, account issues, read-only visibility',
    permissions: ['dashboard.view', 'restaurants.view', 'merchant.view', 'subscriptions.view', 'users.view', 'users.manage', 'support.view', 'support.manage', 'notifications.view', 'monitoring.view'],
  },
  ANALYST: { label: 'Read-only analyst', description: 'Business numbers only: restaurants, subscriptions and payments. Cannot change anything', permissions: ANALYST_VIEWS },
  COMPLIANCE: {
    label: 'Compliance / Grievance officer',
    description: 'Handles privacy requests and complaints; can read the audit log. Cannot change billing, settings or accounts',
    permissions: ['dashboard.view', 'privacy.view', 'privacy.manage', 'audit.view', 'restaurants.view'],
  },
};

export function resolvePlatformPermissions(role: string | null | undefined, explicit?: string[] | null): string[] {
  if (Array.isArray(explicit) && explicit.length > 0) return explicit.filter((p) => ALL_PERMISSIONS.includes(p));
  // Accounts created before roles existed have no role at all and were always full administrators.
  if (role === null || role === undefined || role === '') return PLATFORM_ROLES.OWNER.permissions;
  // Anything else must be a known role. An unknown or misspelt role gets NOTHING (fail closed), never full access.
  return PLATFORM_ROLES[role]?.permissions ?? [];
}
