import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';
import { PlatformAdminGuard, RequirePermission } from './guards.js';
import { actorOf, PlatformAuditService } from './audit.service.js';
import { PlatformSettingsService } from './settings.service.js';
import { PlatformEventsService } from './events.service.js';
import { DashboardService } from './dashboard.service.js';
import { RestaurantsAdminService } from './restaurants-admin.service.js';
import { SubscriptionsAdminService } from './subscriptions-admin.service.js';
import { FinanceService } from './finance.service.js';
import { UsersAdminService } from './users-admin.service.js';
import { CommsService, TEMPLATE_VARIABLES } from './comms.service.js';
import { MonitoringService } from './monitoring.service.js';
import { JobsService } from './jobs.service.js';
import { ExportsService } from './exports.service.js';
import { SupportService, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from './support.service.js';
import { FEATURE_CATALOG, isFeatureAvailable } from '../subscriptions/subscription-access.js';
import { invalidateFeatureCache } from './features.js';
import {
  AckDto, AdminCreateDto, AdminUpdateDto, AnnouncementDto, AssignDto, CancelSubDto, ChangePlanDto, ExtendDto, FeatureOverrideDto, FlagDto, MarkReadDto,
  MerchantTicketDto, NoteDto, OutletStatusDto, ReactivateDto, RestaurantStatusDto, SendNotificationDto, SettingsDto, StartTrialDto, TemplateDto,
  TicketCreateDto, TicketEventDto, TicketReplyDto, TicketUpdateDto, UserActiveDto, VerificationDto,
} from './dto.js';

const uuid = new ParseUUIDPipe({ version: undefined });

/** Everything the Super Admin console calls. Every route declares the permission it needs; undeclared routes are denied. */
@Controller('admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PlatformController {
  constructor(
    private readonly ds: DataSource,
    private readonly audit: PlatformAuditService,
    private readonly settings: PlatformSettingsService,
    private readonly events: PlatformEventsService,
    private readonly dashboard: DashboardService,
    private readonly restaurants: RestaurantsAdminService,
    private readonly subs: SubscriptionsAdminService,
    private readonly finance: FinanceService,
    private readonly users: UsersAdminService,
    private readonly comms: CommsService,
    private readonly monitoring: MonitoringService,
    private readonly jobs: JobsService,
    private readonly exportsSvc: ExportsService,
    private readonly support: SupportService,
  ) {}

  // ── session / dashboard ──────────────────────────────────────────────────
  @Get('me/access') @RequirePermission('dashboard.view')
  async myAccess(@Req() req: any) {
    return withMessage({ role: req.user.platformRole, permissions: req.user.platformPermissions }, 'Access');
  }

  @Get('dashboard') @RequirePermission('dashboard.view')
  async getDashboard(@Query() q: any) {
    return withMessage(await this.dashboard.overview(q), 'Dashboard');
  }

  @Get('events') @RequirePermission('dashboard.view')
  async listEvents(@Query('limit') limit?: string, @Query('unread') unread?: string) {
    return withMessage(await this.events.list(Number(limit) || 30, unread === 'true'), 'Events');
  }

  @Post('events/ack') @HttpCode(200) @RequirePermission('support.manage')
  async ackEvents(@Body() dto: AckDto, @Req() req: any) {
    await this.events.acknowledge(dto.id ?? null, req.user.name);
    return withMessage({ ok: true }, 'Acknowledged');
  }

  // ── restaurants ──────────────────────────────────────────────────────────
  @Get('restaurants') @RequirePermission('restaurants.view')
  async listRestaurants(@Query() q: any) {
    return withMessage(await this.restaurants.list(q), 'Restaurants');
  }
  @Get('restaurants/:id') @RequirePermission('restaurants.view')
  async getRestaurant(@Param('id', uuid) id: string) {
    return withMessage(await this.restaurants.get(id), 'Restaurant');
  }
  @Get('restaurants/:id/activity') @RequirePermission('restaurants.view')
  async restaurantActivity(@Param('id', uuid) id: string, @Query('days') days?: string) {
    return withMessage(await this.restaurants.activity(id, Number(days) || 30), 'Activity');
  }
  @Get('restaurants/:id/billing') @RequirePermission('subscriptions.view')
  async restaurantBilling(@Param('id', uuid) id: string) {
    return withMessage(await this.restaurants.billing(id), 'Billing');
  }
  @Get('restaurants/:id/notes') @RequirePermission('restaurants.view')
  async restaurantNotes(@Param('id', uuid) id: string) {
    return withMessage(await this.restaurants.listNotes(id), 'Notes');
  }
  @Post('restaurants/:id/notes') @RequirePermission('restaurants.manage')
  async addRestaurantNote(@Param('id', uuid) id: string, @Body() dto: NoteDto, @Req() req: any) {
    return withMessage(await this.restaurants.addNote(id, dto.body, !!dto.pinned, actorOf(req)), 'Note added');
  }
  @Post('restaurants/:id/status') @HttpCode(200) @RequirePermission('restaurants.manage')
  async setRestaurantStatus(@Param('id', uuid) id: string, @Body() dto: RestaurantStatusDto, @Req() req: any) {
    return withMessage(await this.restaurants.setStatus(id, dto.action, dto.reason, actorOf(req)), 'Account status updated');
  }
  @Post('restaurants/:id/verification') @HttpCode(200) @RequirePermission('restaurants.manage')
  async setVerification(@Param('id', uuid) id: string, @Body() dto: VerificationDto, @Req() req: any) {
    return withMessage(await this.restaurants.setVerification(id, dto.status, dto.note, actorOf(req)), 'Verification updated');
  }
  @Post('restaurants/:id/feature-overrides') @HttpCode(200) @RequirePermission('restaurants.manage', 'settings.manage')
  async featureOverride(@Param('id', uuid) id: string, @Body() dto: FeatureOverrideDto, @Req() req: any) {
    return withMessage(await this.restaurants.setFeatureOverride(id, dto.feature, dto.mode, dto.reason, actorOf(req)), 'Feature access updated');
  }
  @Post('outlets/:id/status') @HttpCode(200) @RequirePermission('restaurants.manage')
  async setOutletStatus(@Param('id', uuid) id: string, @Body() dto: OutletStatusDto, @Req() req: any) {
    return withMessage(await this.restaurants.setOutletActive(id, dto.isActive, dto.reason, actorOf(req)), 'Outlet updated');
  }
  @Get('outlets-monitor') @RequirePermission('restaurants.view')
  async outletMonitor(@Query() q: any) {
    return withMessage(await this.monitoring.outlets(q), 'Outlets');
  }

  // ── subscriptions ────────────────────────────────────────────────────────
  @Get('subscriptions') @RequirePermission('subscriptions.view')
  async listSubscriptions(@Query() q: any) {
    return withMessage(await this.subs.list(q), 'Subscriptions');
  }
  @Get('subscription-plans') @RequirePermission('subscriptions.view')
  async plans() {
    return withMessage({ plans: await this.subs.plansWithUsage(), features: await this.featureCatalog(), trial: await this.subs.trialConfiguration() }, 'Plans');
  }
  @Get('subscriptions/capacity') @RequirePermission('subscriptions.view')
  async capacity() {
    return withMessage(await this.subs.capacityWatch(), 'Restaurants close to or over their plan limits');
  }
  @Get('subscriptions/founding') @RequirePermission('subscriptions.view')
  async founding() {
    return withMessage(await this.subs.foundingGrants(), 'Founding 10 grants');
  }
  @Get('restaurants/:id/subscription-history') @RequirePermission('subscriptions.view')
  async subHistory(@Param('id', uuid) id: string) {
    return withMessage(await this.subs.history(id), 'History');
  }
  @Post('restaurants/:id/subscription/change-plan') @HttpCode(200) @RequirePermission('subscriptions.manage')
  async changePlan(@Param('id', uuid) id: string, @Body() dto: ChangePlanDto, @Req() req: any) {
    return withMessage(await this.subs.changePlan(id, dto, actorOf(req)), 'Plan changed');
  }
  @Post('restaurants/:id/subscription/extend') @HttpCode(200) @RequirePermission('subscriptions.manage')
  async extend(@Param('id', uuid) id: string, @Body() dto: ExtendDto, @Req() req: any) {
    return withMessage(await this.subs.extend(id, dto, actorOf(req)), 'Subscription extended');
  }
  @Post('restaurants/:id/subscription/cancel') @HttpCode(200) @RequirePermission('subscriptions.manage')
  async cancel(@Param('id', uuid) id: string, @Body() dto: CancelSubDto, @Req() req: any) {
    return withMessage(await this.subs.cancel(id, dto, actorOf(req)), 'Cancellation recorded');
  }
  @Post('restaurants/:id/subscription/reactivate') @HttpCode(200) @RequirePermission('subscriptions.manage')
  async reactivate(@Param('id', uuid) id: string, @Body() dto: ReactivateDto, @Req() req: any) {
    return withMessage(await this.subs.reactivate(id, dto, actorOf(req)), 'Subscription reactivated');
  }
  @Post('restaurants/:id/subscription/trial') @HttpCode(200) @RequirePermission('subscriptions.manage')
  async trial(@Param('id', uuid) id: string, @Body() dto: StartTrialDto, @Req() req: any) {
    return withMessage(await this.subs.startTrial(id, dto, actorOf(req)), 'Trial started');
  }
  @Post('restaurants/:id/subscription/assign') @HttpCode(200) @RequirePermission('subscriptions.manage')
  async assign(@Param('id', uuid) id: string, @Body() dto: AssignDto, @Req() req: any) {
    return withMessage(await this.subs.assign(id, dto, actorOf(req)), 'Plan granted');
  }

  // ── payments ─────────────────────────────────────────────────────────────
  @Get('payments') @RequirePermission('payments.view')
  async payments(@Query() q: any) {
    return withMessage(await this.finance.transactions(q), 'Payments');
  }
  @Get('payments/overview') @RequirePermission('payments.view')
  async paymentsOverview(@Query() q: any) {
    return withMessage(await this.finance.overview(q), 'Payments overview');
  }
  @Get('payments/reconciliation') @RequirePermission('payments.view')
  async reconciliation() {
    return withMessage(await this.finance.reconciliation(), 'Reconciliation');
  }

  // ── users & administrators ───────────────────────────────────────────────
  @Get('users') @RequirePermission('users.view')
  async listUsers(@Query() q: any) {
    return withMessage(await this.users.list(q), 'Users');
  }
  @Get('users/:id') @RequirePermission('users.view')
  async getUser(@Param('id', uuid) id: string) {
    return withMessage(await this.users.get(id), 'User');
  }
  @Post('users/:id/active') @HttpCode(200) @RequirePermission('users.manage')
  async userActive(@Param('id', uuid) id: string, @Body() dto: UserActiveDto, @Req() req: any) {
    return withMessage(await this.users.setActive(id, dto.isActive, dto.reason, actorOf(req)), 'User updated');
  }
  @Post('users/:id/unlock') @HttpCode(200) @RequirePermission('users.manage')
  async userUnlock(@Param('id', uuid) id: string, @Req() req: any) {
    return withMessage(await this.users.unlock(id, actorOf(req)), 'User unlocked');
  }
  @Post('users/:id/logout') @HttpCode(200) @RequirePermission('users.manage')
  async userLogout(@Param('id', uuid) id: string, @Req() req: any) {
    return withMessage(await this.users.forceLogout(id, actorOf(req)), 'Sessions revoked');
  }
  @Post('users/:id/reset-password') @HttpCode(200) @RequirePermission('users.manage')
  async userReset(@Param('id', uuid) id: string, @Req() req: any) {
    return withMessage(await this.users.resetPassword(id, actorOf(req)), 'Password reset');
  }

  @Get('access/catalog') @RequirePermission('users.view')
  async accessCatalog() {
    return withMessage(this.users.access(), 'Access catalogue');
  }
  @Get('admins') @RequirePermission('users.view')
  async admins() {
    return withMessage(await this.users.admins(), 'Administrators');
  }
  @Post('admins') @RequirePermission('admins.manage')
  async createAdmin(@Body() dto: AdminCreateDto, @Req() req: any) {
    return withMessage(await this.users.createAdmin(dto, actorOf(req)), 'Administrator created');
  }
  @Patch('admins/:id') @RequirePermission('admins.manage')
  async updateAdmin(@Param('id', uuid) id: string, @Body() dto: AdminUpdateDto, @Req() req: any) {
    return withMessage(await this.users.updateAdmin(id, dto, actorOf(req)), 'Administrator updated');
  }
  @Post('admins/:id/reset-password') @HttpCode(200) @RequirePermission('admins.manage')
  async resetAdminPw(@Param('id', uuid) id: string, @Req() req: any) {
    return withMessage(await this.users.resetAdminPassword(id, actorOf(req)), 'Password reset');
  }
  @Get('admin-logins') @RequirePermission('audit.view')
  async adminLogins() {
    return withMessage(await this.users.adminLogins(), 'Administrator sign-ins');
  }

  // ── settings & feature access ────────────────────────────────────────────
  @Get('settings') @RequirePermission('settings.view')
  async getSettings() {
    return withMessage(await this.settings.list(), 'Settings');
  }
  @Put('settings') @RequirePermission('settings.manage')
  async putSettings(@Body() dto: SettingsDto, @Req() req: any) {
    const actor = actorOf(req);
    const diff = await this.settings.update(dto.changes, actor.name || actor.email || 'admin');
    const keys = Object.keys(diff);
    await this.audit.record(actor, {
      action: keys.some((k) => k.startsWith('operations.maintenance')) ? 'MAINTENANCE_SETTINGS_CHANGED' : 'SETTINGS_CHANGED', category: 'SETTINGS', entityType: 'settings',
      entityLabel: keys.join(', ').slice(0, 190), summary: `Changed ${keys.length} platform setting(s): ${keys.join(', ')}`.slice(0, 900), changes: diff,
    });
    return withMessage(await this.settings.list(), 'Settings saved');
  }

  private async featureCatalog() {
    const rows: any[] = await this.ds.query(`SELECT f.feature_key, f.enabled, f.description, f.updated_by, f.updated_at, (SELECT COUNT(*)::int FROM org_feature_overrides o WHERE o.feature_key = f.feature_key) AS overrides FROM feature_flags f ORDER BY f.feature_key`);
    // `available` = something real sits behind the key; unavailable keys are shown but cannot be sold (plans reject them)
    return rows.map((r) => ({ ...r, available: isFeatureAvailable(r.feature_key), label: FEATURE_CATALOG[r.feature_key]?.label ?? r.feature_key, note: FEATURE_CATALOG[r.feature_key]?.note ?? null }));
  }
  @Get('feature-flags') @RequirePermission('settings.view')
  async flags() {
    return withMessage(await this.featureCatalog(), 'Feature flags');
  }
  @Patch('feature-flags/:key') @RequirePermission('settings.manage')
  async setFlag(@Param('key') key: string, @Body() dto: FlagDto, @Req() req: any) {
    const before = (await this.ds.query('SELECT enabled FROM feature_flags WHERE feature_key = $1', [key]))[0];
    if (!before) throw new BadRequestException(`Unknown feature '${key}'`);
    const actor = actorOf(req);
    await this.ds.query('UPDATE feature_flags SET enabled = $2, updated_by = $3, updated_at = now() WHERE feature_key = $1', [key, dto.enabled, actor.name || actor.email]);
    invalidateFeatureCache();
    await this.audit.record(actor, {
      action: 'FEATURE_FLAG_CHANGED', category: 'SETTINGS', entityType: 'feature', entityId: key, entityLabel: key,
      summary: `${dto.enabled ? 'Enabled' : 'Disabled'} ${key} platform-wide`, changes: { enabled: { from: before.enabled, to: dto.enabled } }, reason: dto.reason ?? null,
    });
    if (!dto.enabled) await this.events.emit('FEATURE_DISABLED', 'WARNING', `${key} disabled platform-wide`, dto.reason, { actorName: actor.name || undefined });
    return withMessage(await this.featureCatalog(), 'Feature updated');
  }

  // ── communications ───────────────────────────────────────────────────────
  @Get('communications/history') @RequirePermission('notifications.view')
  async commsHistory(@Query() q: any) {
    return withMessage(await this.comms.history(q), 'History');
  }
  @Get('communications/history/:id') @RequirePermission('notifications.view')
  async commsDeliveries(@Param('id', uuid) id: string) {
    return withMessage(await this.comms.deliveries(id), 'Deliveries');
  }
  @Post('communications/send') @HttpCode(200) @RequirePermission('notifications.send')
  async send(@Body() dto: SendNotificationDto, @Req() req: any) {
    return withMessage(await this.comms.send(dto, actorOf(req)), 'Notification sent');
  }
  @Get('communications/templates') @RequirePermission('notifications.view')
  async templates() {
    return withMessage({ templates: await this.comms.templates(), variables: TEMPLATE_VARIABLES, emailConfigured: this.comms.emailConfigured() }, 'Templates');
  }
  @Post('communications/templates') @RequirePermission('notifications.send')
  async createTemplate(@Body() dto: TemplateDto, @Req() req: any) {
    return withMessage(await this.comms.saveTemplate(null, dto, actorOf(req)), 'Template created');
  }
  @Put('communications/templates/:id') @RequirePermission('notifications.send')
  async updateTemplate(@Param('id', uuid) id: string, @Body() dto: TemplateDto, @Req() req: any) {
    return withMessage(await this.comms.saveTemplate(id, dto, actorOf(req)), 'Template saved');
  }
  @Get('communications/announcements') @RequirePermission('notifications.view')
  async announcements() {
    return withMessage(await this.comms.announcements(), 'Announcements');
  }
  @Post('communications/announcements') @RequirePermission('notifications.send')
  async createAnnouncement(@Body() dto: AnnouncementDto, @Req() req: any) {
    return withMessage(await this.comms.saveAnnouncement(null, dto, actorOf(req)), 'Announcement published');
  }
  @Put('communications/announcements/:id') @RequirePermission('notifications.send')
  async updateAnnouncement(@Param('id', uuid) id: string, @Body() dto: AnnouncementDto, @Req() req: any) {
    return withMessage(await this.comms.saveAnnouncement(id, dto, actorOf(req)), 'Announcement saved');
  }

  // ── monitoring ───────────────────────────────────────────────────────────
  @Get('monitoring/health') @RequirePermission('monitoring.view')
  async health() {
    return withMessage({ ...(await this.monitoring.health()), jobCatalog: this.jobs.list() }, 'Health');
  }
  @Get('monitoring/errors') @RequirePermission('monitoring.view')
  async errors(@Query() q: any) {
    return withMessage(await this.monitoring.errors(q), 'Errors');
  }
  @Get('monitoring/webhooks') @RequirePermission('monitoring.view')
  async webhooks(@Query() q: any) {
    return withMessage(await this.monitoring.webhooks(q), 'Webhooks');
  }
  @Get('monitoring/jobs') @RequirePermission('monitoring.view')
  async jobRuns(@Query('name') name?: string) {
    return withMessage(await this.monitoring.jobRuns(name), 'Job runs');
  }
  @Post('monitoring/jobs/:name/run') @HttpCode(200) @RequirePermission('settings.manage')
  async runJob(@Param('name') name: string, @Req() req: any) {
    if (!this.jobs.list().some((j) => j.name === name)) throw new BadRequestException('Unknown job');
    const result = await this.jobs.execute(name, true);
    await this.audit.record(actorOf(req), { action: 'JOB_RUN_MANUALLY', category: 'SYSTEM', entityType: 'job', entityId: name, entityLabel: name, summary: `Ran background job ${name} manually` });
    return withMessage(result ?? { status: 'SKIPPED', reason: 'Another run is in progress' }, 'Job executed');
  }

  // ── audit ────────────────────────────────────────────────────────────────
  @Get('audit') @RequirePermission('audit.view')
  async auditList(@Query() q: any) {
    return withMessage(await this.audit.list(q), 'Audit log');
  }

  // ── support ──────────────────────────────────────────────────────────────
  @Get('support/meta') @RequirePermission('support.view')
  async supportMeta() {
    const staff = await this.ds.query(`SELECT id, name FROM staff WHERE (is_platform_admin = true OR role = 'PLATFORM_SUPER_ADMIN') AND is_active = true ORDER BY name`);
    return withMessage({ categories: TICKET_CATEGORIES, priorities: TICKET_PRIORITIES, statuses: TICKET_STATUSES, assignees: staff }, 'Meta');
  }
  @Get('support/tickets') @RequirePermission('support.view')
  async tickets(@Query() q: any) {
    return withMessage(await this.support.list(q), 'Tickets');
  }
  @Get('support/tickets/:id') @RequirePermission('support.view')
  async ticket(@Param('id', uuid) id: string) {
    return withMessage(await this.support.get(id), 'Ticket');
  }
  @Post('support/tickets') @RequirePermission('support.manage')
  async createTicket(@Body() dto: TicketCreateDto, @Req() req: any) {
    return withMessage(await this.support.createByAdmin(dto, actorOf(req)), 'Ticket created');
  }
  @Patch('support/tickets/:id') @RequirePermission('support.manage')
  async updateTicket(@Param('id', uuid) id: string, @Body() dto: TicketUpdateDto, @Req() req: any) {
    return withMessage(await this.support.update(id, dto, actorOf(req)), 'Ticket updated');
  }
  @Post('support/tickets/:id/events') @HttpCode(200) @RequirePermission('support.manage')
  async ticketEvent(@Param('id', uuid) id: string, @Body() dto: TicketEventDto, @Req() req: any) {
    return withMessage(await this.support.addEvent(id, dto.kind, dto.body, actorOf(req)), 'Saved');
  }

  // ── exports ──────────────────────────────────────────────────────────────
  @Get('reports/finance/:kind') @RequirePermission('payments.export')
  async financeReport(@Param('kind') kind: string, @Query() q: any, @Req() req: any) {
    if (!['payments', 'revenue-by-month', 'subscriptions'].includes(kind)) throw new BadRequestException(`Unknown finance report '${kind}'`);
    return withMessage(await this.exportsSvc.report(kind, q, actorOf(req)), 'Report ready');
  }
  @Get('reports/data/:kind') @RequirePermission('exports.manage')
  async dataReport(@Param('kind') kind: string, @Query() q: any, @Req() req: any) {
    if (!['restaurants', 'users'].includes(kind)) throw new BadRequestException(`Unknown report '${kind}'`);
    return withMessage(await this.exportsSvc.report(kind, q, actorOf(req)), 'Report ready');
  }
  @Get('reports/audit') @RequirePermission('audit.view')
  async auditReport(@Query() q: any, @Req() req: any) {
    return withMessage(await this.exportsSvc.report('audit', q, actorOf(req)), 'Report ready');
  }
  @Get('restaurants/:id/export') @RequirePermission('exports.manage')
  async exportRestaurant(@Param('id', uuid) id: string, @Req() req: any) {
    return withMessage(await this.exportsSvc.organization(id, actorOf(req)), 'Export ready');
  }
  @Get('exports') @RequirePermission('exports.manage')
  async exportHistory() {
    return withMessage(await this.exportsSvc.history(), 'Exports');
  }
}

// ── restaurant-facing endpoints ──────────────────────────────────────────────
@Controller()
export class PlatformPublicController {
  constructor(private readonly settings: PlatformSettingsService, private readonly comms: CommsService, private readonly support: SupportService, private readonly ds: DataSource) {}

  /** Branding + maintenance state: safe for the sign-in page. */
  @Get('platform/config')
  config() {
    return withMessage(this.settings.publicConfig(), 'Platform configuration');
  }

  private async orgOf(user: any): Promise<string | null> {
    if (user.organizationId) return user.organizationId;
    if (user.restaurantId) return (await this.ds.query('SELECT organization_id FROM restaurants WHERE id = $1', [user.restaurantId]))[0]?.organization_id ?? null;
    return null;
  }

  @Get('platform/announcements') @UseGuards(JwtAuthGuard)
  async announcements(@Req() req: any) {
    return withMessage(await this.comms.activeFor(await this.orgOf(req.user)), 'Announcements');
  }

  @Get('notifications/inbox') @UseGuards(JwtAuthGuard)
  async inbox(@Req() req: any) {
    return withMessage(await this.comms.inbox(req.user.id), 'Inbox');
  }
  @Post('notifications/inbox/read') @HttpCode(200) @UseGuards(JwtAuthGuard)
  async read(@Req() req: any, @Body() dto: MarkReadDto) {
    await this.comms.markRead(req.user.id, dto.id ?? null);
    return withMessage({ ok: true }, 'Marked as read');
  }

  @Get('support/meta') @UseGuards(JwtAuthGuard)
  supportMeta() {
    return withMessage({ categories: TICKET_CATEGORIES, priorities: TICKET_PRIORITIES }, 'Meta');
  }
  @Post('support/tickets') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async create(@Req() req: any, @Body() dto: MerchantTicketDto) {
    this.support.assertMerchant(req.user);
    return withMessage(await this.support.createFromMerchant(req.user, dto), 'Request sent to the Pangat team');
  }
  @Get('support/tickets') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async mine(@Req() req: any) {
    this.support.assertMerchant(req.user);
    return withMessage(await this.support.mine(req.user), 'Your requests');
  }
  @Get('support/tickets/:id') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async mineDetail(@Req() req: any, @Param('id', uuid) id: string) {
    this.support.assertMerchant(req.user);
    return withMessage(await this.support.mineDetail(req.user, id), 'Request');
  }
  @Post('support/tickets/:id/reply') @HttpCode(200) @UseGuards(JwtAuthGuard, RolesGuard) @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async reply(@Req() req: any, @Param('id', uuid) id: string, @Body() dto: TicketReplyDto) {
    this.support.assertMerchant(req.user);
    return withMessage(await this.support.replyFromMerchant(req.user, id, dto.body), 'Reply sent');
  }
}
