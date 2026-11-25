import { chromium, newPage, login, shot, check, results, BASE } from './ui.mjs';
import * as S from './seed.mjs'; import fs from 'node:fs';
const st=JSON.parse(fs.readFileSync('/tmp/uat_state.json'));
// fresh tenant on its own plan so the over-limit report is about this scenario
const run=Math.random().toString(36).slice(2,6);
const adm=await S.adminToken(run);
const plan=await S.makePlan(adm,run,'dplan',{outlets:1,tables:8,staff:5,features:['QR_ORDERING','KDS']});
const o=await S.onboard(run,'d',plan,{indoorTableCount:6});
const browser=await chromium.launch(); const p=await newPage(browser);
await p.goto(BASE+'/login',{waitUntil:'networkidle'}); await p.waitForSelector('input[type=email]',{timeout:60000}); await p.fill('input[type=email]',adm.email); await p.fill('input[type=password]',S.PW); await p.getByRole('button',{name:/^sign in$/i}).click(); await p.waitForURL(/super-admin/,{timeout:30000});
await p.goto(BASE+'/super-admin/subscriptions',{waitUntil:'networkidle'}); await p.getByText('Plans & feature access').first().click(); await p.waitForTimeout(1500);
check('D1','Super Admin opens subscription management (plans & feature access)',/Feature access by plan|Included/i.test(await p.locator('body').innerText()));
// feature matrix shows ADVANCED_REPORTS as not built
const bt=await p.locator('body').innerText(); await shot(p,'D01-plans-feature-matrix');
check('D2','the feature matrix marks Advanced reports as "not built yet, not sold"',/not built yet/i.test(bt),(bt.match(/Advanced reports[^\n]*/i)||[''])[0]);
// open the plan card
const card=p.locator('section',{hasText:plan.name}).first();
await card.getByRole('button',{name:/Edit/}).click(); await p.waitForTimeout(1000); await shot(p,'D02-plan-editor');
const et=await p.locator('body').innerText();
check('D3','plan editor offers Advanced reports only as a disabled "not built yet" option',/not built yet/i.test(et)&&await p.locator('label:has-text("not built yet") input[type=checkbox]').first().isDisabled().catch(()=>false));
const tbl=p.locator('label:has-text("Tables per outlet")').locator('input').first();
await tbl.fill('3'); await p.getByRole('button',{name:/save|update plan/i}).last().click(); await p.waitForTimeout(2000); await shot(p,'D03-over-limit-warning');
const st2=await p.locator('body').innerText();
check('D4','lowering the limit below current usage (6 tables, new limit 3) shows the over-limit warning',/now above this plan's limits/i.test(st2),(st2.match(/[^\n]*above this plan[^\n]*/)||[''])[0].slice(0,120));
const cnt=(await S.db.query('SELECT COUNT(*) FROM tables WHERE restaurant_id=$1',[o.outlet.id])).rows[0].count; check('D5','nothing was deleted: the outlet still has its 6 tables',cnt==='6',cnt);
// owner is blocked
const ow=await newPage(browser); await login(ow,o.email,S.PW); await ow.goto(BASE+'/admin/tables',{waitUntil:'networkidle'}); await ow.waitForTimeout(1000);
await ow.getByRole('button',{name:'Add Table'}).click(); await ow.getByPlaceholder('e.g. T13, OD05, VIP1').fill('OV1'); await ow.locator('button[type=submit]').filter({hasText:/add|create/i}).first().click(); await ow.waitForTimeout(1500); await shot(ow,'D04-owner-over-limit-blocked');
check('D6','the owner of the over-limit restaurant cannot add a table and is told why',/already over the 3 tables/i.test(await ow.locator('body').innerText()),((await ow.locator('body').innerText()).match(/Plan limit reached[^\n]*/)||[''])[0].slice(0,120));
// authorised override: API only (no UI control exists) ─ then verify it in the restaurant's subscription history in the UI
const ov=await S.call('POST','/tables',{token:adm.token,body:{restaurantId:o.outlet.id,tableNumber:'OVR1',limitOverrideReason:'UAT: owner holds a private event, approved by founder'}});
check('D7','an authorised Super Admin override succeeds (API; the console has no override control)',ov.status===201,`HTTP ${ov.status}`);
await p.goto(`${BASE}/super-admin/restaurants/${o.orgId}`,{waitUntil:'networkidle'}); await p.waitForTimeout(1500);
await p.getByText(/^Subscription$/).first().click().catch(()=>{}); await p.waitForTimeout(1500); await shot(p,'D05-subscription-history');
const ht=await p.locator('body').innerText();
check('D8','the override appears in the restaurant\'s audit/subscription history in the console',/limit overridden|PLAN_LIMIT_OVERRIDDEN|override/i.test(ht),(ht.match(/[^\n]*overrid[^\n]*/i)||['(not visible in UI)'])[0].slice(0,120));
// unauthorised admin
const e=`support-${run}@pangat.test`; await S.call('POST','/admin/admins',{token:adm.token,body:{name:'Sup',email:e,role:'SUPPORT',password:S.PW+'xyz'}});
const f=await S.call('POST','/auth/login',{body:{email:e,password:S.PW+'xyz'}}); const ch=await S.call('POST','/auth/change-password',{token:f.data.accessToken,body:{currentPassword:S.PW+'xyz',newPassword:S.PW2}});
const bad=await S.call('POST','/tables',{token:ch.data.accessToken,body:{restaurantId:o.outlet.id,tableNumber:'OVR2',limitOverrideReason:'UAT: unauthorised attempt to override the limit'}});
check('D9','an unauthorised administrator (Support role) cannot override (API)',bad.status===403,`HTTP ${bad.status}`);
const u=await newPage(browser); await u.goto(BASE+'/login',{waitUntil:'networkidle'}); await u.waitForSelector('input[type=email]'); await u.fill('input[type=email]',e); await u.fill('input[type=password]',S.PW2); await u.getByRole('button',{name:/^sign in$/i}).click(); await u.waitForURL(/super-admin/,{timeout:30000});
await u.goto(BASE+'/super-admin/subscriptions',{waitUntil:'networkidle'}); await u.getByText('Plans & feature access').first().click().catch(()=>{}); await u.waitForTimeout(1500); await shot(u,'D06-support-no-edit');
const edits=await u.getByRole('button',{name:/^Edit$/}).count(); const newPlan=await u.getByRole('button',{name:/New plan/}).count();
check('D10','the Support administrator sees no plan Edit / New plan controls in the console',edits===0&&newPlan===0,`edit buttons=${edits}, new plan=${newPlan}`);
// provisioning UI cannot exceed the plan silently
const prov=await S.call('POST','/admin/provision',{token:adm.token,body:{brandName:'UAT P',ownerFullName:'P',email:`p-${run}@example.com`,mobileNumber:'9876500002',outletName:'P',slug:`uat-p-${run}`,upiVpa:'a@upi',indoorTableCount:100,outdoorTableCount:50,menuPreset:'blank'}});
check('D11','provisioning 150 tables without an override is refused',prov.status===403&&prov.code==='PLAN_LIMIT_REACHED',`HTTP ${prov.status} ${prov.code}`);
await browser.close(); fs.writeFileSync('/home/user/uat/resultsD.json',JSON.stringify(results)); process.exit(0)
