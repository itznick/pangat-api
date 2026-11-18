// Every platform setting the code actually reads. Unknown keys are rejected on write, so nothing here is decorative.
export type SettingType = 'string' | 'number' | 'boolean' | 'text' | 'datetime' | 'email';

export interface SettingDef {
  key: string;
  group: string;
  label: string;
  help?: string;
  type: SettingType;
  secret?: boolean;
  default: string | number | boolean | null;
  min?: number;
  max?: number;
}

export const SETTING_GROUPS: { id: string; label: string; description: string }[] = [
  { id: 'branding', label: 'Branding', description: 'Name and contact details shown to restaurants' },
  { id: 'general', label: 'General', description: 'Application-wide switches' },
  { id: 'subscription', label: 'Subscription defaults', description: 'Trial and grace-period rules enforced by the API' },
  { id: 'billing', label: 'Tax & billing', description: 'Defaults applied to new plans and tax invoices' },
  { id: 'email', label: 'Email', description: 'Transactional email provider' },
  { id: 'notifications', label: 'Event notifications', description: 'Which platform events raise alerts' },
  { id: 'gateway', label: 'Payment gateway', description: 'Razorpay webhook verification' },
  { id: 'operations', label: 'Maintenance', description: 'Maintenance mode and scheduled windows' },
  { id: 'security', label: 'Security', description: 'Sign-in protection' },
];

export const SETTINGS: SettingDef[] = [
  { key: 'branding.platformName', group: 'branding', label: 'Platform name', type: 'string', default: 'Pangat' },
  { key: 'branding.supportEmail', group: 'branding', label: 'Support email', type: 'email', default: null },
  { key: 'branding.supportPhone', group: 'branding', label: 'Support phone', type: 'string', default: null },
  { key: 'branding.logoUrl', group: 'branding', label: 'Logo URL', type: 'string', default: null, help: 'https:// link to a square logo' },

  { key: 'general.selfSignupEnabled', group: 'general', label: 'Allow self-service sign-up', type: 'boolean', default: true, help: 'When off, new restaurants can only be provisioned by a platform admin.' },
  { key: 'general.publicOrderingEnabled', group: 'general', label: 'Accept guest QR orders platform-wide', type: 'boolean', default: true, help: 'Emergency switch: when off, no outlet can accept new guest orders.' },

  { key: 'subscription.defaultTrialDays', group: 'subscription', label: 'Default trial length (days)', type: 'number', default: 14, min: 0, max: 90 },
  { key: 'subscription.defaultTrialPlanCode', group: 'subscription', label: 'Trial plan code', type: 'string', default: 'GROWTH' },
  { key: 'subscription.gracePeriodDays', group: 'subscription', label: 'Grace period after expiry (days)', type: 'number', default: 7, min: 0, max: 60, help: 'How long a lapsed restaurant keeps working before access is restricted.' },
  { key: 'subscription.trialReminderDays', group: 'subscription', label: 'Trial reminder (days before end)', type: 'number', default: 3, min: 0, max: 30 },

  { key: 'billing.gstPercentage', group: 'billing', label: 'Default GST %', type: 'number', default: 18, min: 0, max: 40 },
  { key: 'billing.supplierStateCode', group: 'billing', label: 'Supplier state code', type: 'string', default: '27', help: 'Decides CGST+SGST vs IGST on invoices.' },
  { key: 'billing.supplierGstin', group: 'billing', label: 'Supplier GSTIN', type: 'string', default: null },
  { key: 'billing.sacCode', group: 'billing', label: 'Default SAC code', type: 'string', default: '998314' },
  { key: 'billing.invoicePrefix', group: 'billing', label: 'Invoice number prefix', type: 'string', default: 'PANGAT-INV' },

  { key: 'email.fromEmail', group: 'email', label: 'From address', type: 'email', default: null },
  { key: 'email.fromName', group: 'email', label: 'From name', type: 'string', default: 'Pangat Hospitality' },
  { key: 'email.provider', group: 'email', label: 'Provider', type: 'string', default: null, help: 'brevo, resend or sendgrid. Leave empty to use the first provider that has an API key (EMAIL_PROVIDER env var also works).' },
  { key: 'email.brevoApiKey', group: 'email', label: 'Brevo API key', type: 'string', secret: true, default: null, help: 'Free plan: 300 emails/day. Verify your sender address in Brevo first.' },
  { key: 'email.resendApiKey', group: 'email', label: 'Resend API key', type: 'string', secret: true, default: null, help: 'Free plan: 100 emails/day. Needs a verified sending domain.' },
  { key: 'email.sendgridApiKey', group: 'email', label: 'SendGrid API key', type: 'string', secret: true, default: null },

  { key: 'notifications.alertEmails', group: 'notifications', label: 'Alert recipients', type: 'text', default: null, help: 'Comma-separated emails that receive critical platform alerts.' },
  { key: 'notifications.emailAlerts', group: 'notifications', label: 'Email critical alerts', type: 'boolean', default: false },
  { key: 'notifications.event.NEW_RESTAURANT', group: 'notifications', label: 'New restaurant registered', type: 'boolean', default: true },
  { key: 'notifications.event.PAYMENT_FAILED', group: 'notifications', label: 'Subscription payment failed', type: 'boolean', default: true },
  { key: 'notifications.event.SUBSCRIPTION_EXPIRED', group: 'notifications', label: 'Subscription expired', type: 'boolean', default: true },
  { key: 'notifications.event.WEBHOOK_FAILURE', group: 'notifications', label: 'Webhook rejected or failed', type: 'boolean', default: true },
  { key: 'notifications.event.SUPPORT_TICKET', group: 'notifications', label: 'New support ticket', type: 'boolean', default: true },

  { key: 'gateway.razorpayWebhookSecret', group: 'gateway', label: 'Razorpay webhook secret', type: 'string', secret: true, default: null, help: 'Overrides the RAZORPAY_WEBHOOK_SECRET environment variable when set.' },

  { key: 'operations.maintenanceEnabled', group: 'operations', label: 'Maintenance mode', type: 'boolean', default: false, help: 'Restaurant users see a maintenance notice and cannot use the console. Platform admins are unaffected.' },
  { key: 'operations.maintenanceMessage', group: 'operations', label: 'Maintenance message', type: 'text', default: 'Pangat is undergoing scheduled maintenance. We will be back shortly.' },
  { key: 'operations.maintenanceStart', group: 'operations', label: 'Scheduled window start', type: 'datetime', default: null, help: 'Optional: maintenance switches on automatically in this window.' },
  { key: 'operations.maintenanceEnd', group: 'operations', label: 'Scheduled window end', type: 'datetime', default: null },

  { key: 'security.maxFailedLogins', group: 'security', label: 'Failed sign-ins before lockout', type: 'number', default: 5, min: 3, max: 20 },
  { key: 'security.adminLoginOtp', group: 'security', label: 'Email code for platform admin sign-in', type: 'boolean', default: false, help: 'Platform admins must also enter a 6-digit code emailed to them. Only enforced while an email provider is configured, so a missing provider can never lock everyone out.' },
  { key: 'security.signupEmailOtp', group: 'security', label: 'Verify email on self-service sign-up', type: 'boolean', default: false, help: 'New restaurants must confirm their owner email with a 6-digit code before the account is created. Only enforced while an email provider is configured.' },
  { key: 'security.lockoutMinutes', group: 'security', label: 'Lockout duration (minutes)', type: 'number', default: 15, min: 1, max: 1440 },
];

export const SETTING_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
