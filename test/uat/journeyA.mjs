import { chromium, newPage, login, shot, check, results, BASE } from './ui.mjs';
import * as S from './seed.mjs';
import fs from 'node:fs';
const run=Math.random().toString(36).slice(2,6);
const admin=await S.adminToken(run);
const small=await S.makePlan(admin,run,'small',{outlets:1,tables:4,staff:2,features:['QR_ORDERING','KDS']});
const o=await S.onboard(run,'a',small);   // 2 tables; plan: 4 tables / 2 staff / 1 outlet; no INVENTORY / ANALYTICS / MULTI_OUTLET
fs.writeFileSync('/tmp/uat_state.json',JSON.stringify({run,slug:o.slug,email:o.email,orgId:o.orgId,outletId:o.outlet.id,plan:small,adminEmail:admin.email}));
const browser=await chromium.launch(); const p=await newPage(browser);
await login(p,o.email,S.PW); await p.waitForLoadState('networkidle');
check('A1','owner signs in and lands in the console',/\/admin/.test(p.url()),p.url());
await p.goto(BASE+'/admin/subscription',{waitUntil:'networkidle'}); await p.waitForTimeout(1200); await shot(p,'A02-billing-page');
const body=await p.locator('body').innerText();
check('A2','billing page shows the current plan, its usage (2 / 4 tables) and included features',body.includes(small.name)&&/2\s*\/\s*4/.test(body)&&body.includes('Live kitchen display')&&!body.includes('Inventory & recipes'),'plan + usage + features');
await p.goto(BASE+'/admin/tables',{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
check('A3','sidebar shows lock icons for Reports and Inventory (API says unavailable)',(await p.locator('[aria-label="Not included in your plan"]').count())>=2);
// add tables up to the limit
for (const n of ['T03','T04']) {
  await p.getByRole('button',{name:'Add Table'}).click(); await p.getByPlaceholder('e.g. T13, OD05, VIP1').fill(n);
  await p.locator('button[type=submit]').filter({hasText:/add|create/i}).first().click(); await p.waitForTimeout(900);
}
await p.waitForTimeout(500); await shot(p,'A04-four-tables-at-limit');
let cnt=(await p.getByRole('button',{name:/All Tables/}).innerText());
check('A4','owner adds tables up to the plan limit (4 of 4)',/4/.test(cnt),cnt.replace(/\n/g,' '));
// exceed
await p.getByRole('button',{name:'Add Table'}).click(); await p.getByPlaceholder('e.g. T13, OD05, VIP1').fill('T05');
await p.locator('button[type=submit]').filter({hasText:/add|create/i}).first().click(); await p.waitForTimeout(1200); await shot(p,'A05-exceed-table-limit');
const txt=await p.locator('body').innerText();
check('A5','adding a 5th table is refused with a clear, plan-limit message',/Plan limit reached \(4 tables per outlet\)/.test(txt),(txt.match(/Plan limit reached[^\n]*/)||[''])[0]);
const dbc=await S.db.query('SELECT COUNT(*) FROM tables WHERE restaurant_id=$1',[o.outlet.id]); check('A5b','database still has exactly 4 tables',dbc.rows[0].count==='4',dbc.rows[0].count);
await p.keyboard.press('Escape'); await p.reload({waitUntil:'networkidle'});
// staff
await p.goto(BASE+'/admin/settings',{waitUntil:'networkidle'}); await p.getByText('Team',{exact:true}).first().click(); await p.waitForTimeout(800);
const addMember=async(i)=>{ await p.getByRole('button',{name:/Add team member/}).click(); const form=p.locator('form').last();
  await form.locator('input').nth(0).fill(`Member ${i}`); await form.locator('input[type=email]').fill(`m${i}-${run}@example.com`); await form.locator('input[type=password], input[type=text]').last().fill('Str0ng-pass-1'+i); await form.getByRole('button',{name:/Add member/}).click(); await p.waitForTimeout(1400); };
await addMember(1); await addMember(2);
await shot(p,'A06-two-staff-at-limit');
const seats=await S.db.query(`SELECT COUNT(*) FROM staff WHERE restaurant_id=$1 AND is_active AND email NOT LIKE '%@stations.pangat.app'`,[o.outlet.id]);
check('A6','owner adds staff up to the limit (2 seats; the hidden kitchen account does not count)',seats.rows[0].count==='2',seats.rows[0].count);
await p.getByRole('button',{name:/Add team member/}).click(); const form=p.locator('form').last();
await form.locator('input').nth(0).fill('Member 3'); await form.locator('input[type=email]').fill(`m3-${run}@example.com`); await form.locator('input[type=password], input[type=text]').last().fill('Str0ng-pass-13'); await form.getByRole('button',{name:/Add member/}).click(); await p.waitForTimeout(1500); await shot(p,'A07-exceed-staff-limit');
const t2=await p.locator('body').innerText();
check('A7','adding a 3rd member is refused with a clear message',/Plan limit reached \(2 staff seats per outlet\)/.test(t2),(t2.match(/Plan limit reached[^\n]*/)||[''])[0]);
// outlet without MULTI_OUTLET
await p.goto(BASE+'/admin/dashboard',{waitUntil:'networkidle'}); await p.waitForTimeout(1000);
await p.locator('button').filter({hasText:/UAT a/}).first().click(); await p.waitForTimeout(500); await shot(p,'A08-outlet-switcher');
const addOutlet=p.getByText(/add an outlet/i).first(); console.log('add outlet entry visible:',await addOutlet.isVisible().catch(()=>false));
if (await addOutlet.isVisible().catch(()=>false)) { await addOutlet.click(); await p.waitForTimeout(800); await shot(p,'A09-add-outlet-blocked');
  const t3=await p.locator('body').innerText(); check('A8','adding an outlet shows the "plan does not include multiple outlets" notice and disables Create',/does not include multiple outlets|already have 1/.test(t3)&&await p.getByRole('button',{name:/Create outlet/}).isDisabled(),(t3.match(/Your plan[^\n]*/)||[''])[0]); }
else check('A8','add-outlet entry reachable',false);
await p.keyboard.press('Escape');
// upgrade notices on Reports and Inventory pages
await p.goto(BASE+'/admin/reports',{waitUntil:'networkidle'}); await p.waitForTimeout(1200); await shot(p,'A10-reports-upgrade-notice');
check('A9','Reports page shows the "Not included in your plan" upgrade notice',/Not included in your plan/.test(await p.locator('body').innerText()));
await p.goto(BASE+'/admin/inventory',{waitUntil:'networkidle'}); await p.waitForTimeout(1200); await shot(p,'A11-inventory-upgrade-notice');
check('A10','Inventory page shows the upgrade notice',/Not included in your plan/.test(await p.locator('body').innerText()));
await browser.close(); fs.writeFileSync('/tmp/uatA_results.json',JSON.stringify(results)); process.exit(0)
