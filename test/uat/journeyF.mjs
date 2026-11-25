import { chromium, newPage, login, shot, check, results, BASE } from './ui.mjs';
import * as S from './seed.mjs'; import fs from 'node:fs';
const run=Math.random().toString(36).slice(2,6);
const admin=await S.adminToken(run);
const noInv=await S.makePlan(admin,run,'noinv',{outlets:1,tables:3,staff:3,features:['QR_ORDERING','KDS']});
const withInv=await S.makePlan(admin,run,'inv',{outlets:1,tables:30,staff:3,features:['QR_ORDERING','KDS','INVENTORY','ANALYTICS']});
const o=await S.onboard(run,'f',noInv,{indoorTableCount:3});
const browser=await chromium.launch();
// ── inventory behaviour ──────────────────────────────────────────────────────
async function inventoryRun(label, expectRequests){
  const p=await newPage(browser); const reqs=[]; p.on('request',r=>{ if(/\/inventory\//.test(r.url())) reqs.push(r.url().replace(/^.*\/api\/v1/,'')) });
  await login(p,o.email,S.PW); await p.waitForLoadState('networkidle');
  for (const path of ['/admin/dashboard','/admin/tables','/admin/orders','/admin/menu']) { await p.goto(BASE+path,{waitUntil:'networkidle'}); await p.waitForTimeout(1500); }
  const txt=await p.locator('body').innerText(); await shot(p,`F-${label}`);
  return {reqs,txt,p};
}
let r=await inventoryRun('noinv-unrelated-pages');
check('F1','plan WITHOUT Inventory: unrelated console pages make no inventory request',r.reqs.length===0,`inventory requests=${r.reqs.length}`);
check('F2','...and show no "upgrade to unlock inventory" toast',!/does not include inventory/i.test(r.txt));
// deliberate open
await r.p.goto(BASE+'/admin/inventory',{waitUntil:'networkidle'}); await r.p.waitForTimeout(1500); await shot(r.p,'F-noinv-deliberate-open');
const dt=await r.p.locator('body').innerText();
check('F3','opening Inventory on purpose still shows the "Not included in your plan" notice',/Not included in your plan/.test(dt));
// plan WITH inventory
await S.db.query(`UPDATE organization_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code=$2) WHERE organization_id=$1`,[o.orgId,withInv.code]);
r=await inventoryRun('inv-unrelated-pages');
check('F4','plan WITH Inventory: stock alerts load normally (request made, no toast)',r.reqs.some(u=>/alerts/.test(u))&&!/does not include inventory/i.test(r.txt),r.reqs.join(' '));
await r.p.goto(BASE+'/admin/inventory',{waitUntil:'networkidle'}); await r.p.waitForTimeout(1500);
check('F5','plan WITH Inventory: the Inventory page loads (no upgrade notice)',!/Not included in your plan/.test(await r.p.locator('body').innerText()));
// kill switch → no polling, deliberate open explains
await S.call('PATCH','/admin/feature-flags/INVENTORY',{token:admin.token,body:{enabled:false,reason:'UAT kill switch'}});
r=await inventoryRun('inv-killswitch');
check('F6','platform kill switch on INVENTORY: no background inventory request on other pages',r.reqs.length===0,`requests=${r.reqs.length}`);
await S.call('PATCH','/admin/feature-flags/INVENTORY',{token:admin.token,body:{enabled:true}});
// org override FORCE_OFF on a plan that has it
await S.call('POST',`/admin/restaurants/${o.orgId}/feature-overrides`,{token:admin.token,body:{feature:'INVENTORY',mode:'FORCE_OFF',reason:'UAT'}});
r=await inventoryRun('inv-force-off');
check('F7','organisation override FORCE_OFF: no background inventory request',r.reqs.length===0,`requests=${r.reqs.length}`);
await S.call('POST',`/admin/restaurants/${o.orgId}/feature-overrides`,{token:admin.token,body:{feature:'INVENTORY',mode:'DEFAULT'}});
// legit errors elsewhere still toast: a 402 from a deliberate action (expired subscription write) still announces
await S.call('POST',`/admin/restaurants/${o.orgId}/subscription/cancel`,{token:admin.token,body:{immediate:true,reason:'UAT: lapse to prove real errors still toast'}});
const p2=await newPage(browser); await login(p2,o.email,S.PW); await p2.goto(BASE+'/admin/tables',{waitUntil:'networkidle'}); await p2.waitForTimeout(1200);
await p2.getByRole('button',{name:'Add Table'}).click(); await p2.getByPlaceholder('e.g. T13, OD05, VIP1').fill('F77'); await p2.locator('button[type=submit]').filter({hasText:/add|create/i}).first().click(); await p2.waitForTimeout(1500);
check('F8','a genuine 402 (lapsed subscription, deliberate action) is still announced',/cancelled|renew|subscription/i.test(await p2.locator('body').innerText()));
await S.call('POST',`/admin/restaurants/${o.orgId}/subscription/extend`,{token:admin.token,body:{days:30,reason:'UAT: restore'}});
// ── Super Admin override UI (merchant console) ────────────────────────────────
const small=await S.makePlan(admin,run,'tiny',{outlets:1,tables:3,staff:3,features:['QR_ORDERING','KDS']});
const t=await S.onboard(run,'g',small,{indoorTableCount:3});
const sa=await newPage(browser);
await sa.goto(BASE+'/login',{waitUntil:'networkidle'}); await sa.waitForSelector('input[type=email]'); await sa.fill('input[type=email]',admin.email); await sa.fill('input[type=password]',S.PW); await sa.getByRole('button',{name:/^sign in$/i}).click(); await sa.waitForURL(/super-admin/,{timeout:30000});
await sa.goto(`${BASE}/super-admin/restaurants/${t.orgId}`,{waitUntil:'networkidle'}); await sa.waitForTimeout(1500);
const popupP=sa.context().waitForEvent('page',{timeout:8000}).catch(()=>null);
await sa.getByRole('button',{name:/Open console/}).click(); const pop=await popupP; const con=pop||sa; await con.waitForLoadState('networkidle'); await con.waitForTimeout(2500);
console.log('console url',con.url());
await con.goto(BASE+'/admin/tables',{waitUntil:'networkidle'}); await con.waitForTimeout(2000); await shot(con,'F-superadmin-console-tables');
await con.getByRole('button',{name:'Add Table'}).click(); await con.getByPlaceholder('e.g. T13, OD05, VIP1').fill('SA1'); await con.locator('button[type=submit]').filter({hasText:/add|create/i}).first().click(); await con.waitForTimeout(1500); await shot(con,'F-superadmin-limit-refused');
const refusedTxt=await con.locator('body').innerText();
check('F9','Super Admin: the plan limit refusal is shown and the "Exceed plan limit" control appears',/Plan limit reached \(3 tables per outlet\)/.test(refusedTxt)&&await con.getByTestId('override-open').isVisible());
await con.getByTestId('override-open').click(); await con.waitForTimeout(500);
const applyBtn=con.getByRole('button',{name:'Apply exception'});
check('F10','the confirmation dialog starts with Apply disabled',await applyBtn.isDisabled());
await con.getByTestId('override-reason').fill('too short'); await con.getByTestId('override-ack').check();
check('F11','a reason under 10 characters keeps Apply disabled',await applyBtn.isDisabled());
await con.getByTestId('override-reason').fill('Festival week: four temporary tables, founder approved');
await con.getByTestId('override-ack').uncheck();
check('F12','without the acknowledgement Apply stays disabled',await applyBtn.isDisabled());
await con.getByTestId('override-ack').check(); await shot(con,'F-superadmin-override-dialog');
check('F13','with a valid reason and acknowledgement Apply is enabled',await applyBtn.isEnabled());
await applyBtn.click(); await con.waitForTimeout(2000); await shot(con,'F-superadmin-override-applied');
const made=(await S.db.query(`SELECT 1 FROM tables WHERE restaurant_id=$1 AND table_number='SA1'`,[t.outlet.id])).rowCount===1;
check('F14','the table is created and the success is shown',made&&/audited limit exception/.test(await con.locator('body').innerText()),`created=${made}`);
const pa=(await S.db.query(`SELECT actor_email, reason, changes, summary FROM platform_audit_logs WHERE organization_id=$1 AND action='PLAN_LIMIT_OVERRIDDEN'`,[t.orgId])).rows[0];
check('F15','audit record has actor, reason, limit type, current usage and requested usage',pa&&pa.actor_email===admin.email&&/Festival week/.test(pa.reason)&&pa.changes.kind==='tables'&&pa.changes.current===3&&pa.changes.adding===1&&pa.changes.limit===3,JSON.stringify(pa?.changes));
// restaurant owner at the limit: no control
const ow=await newPage(browser); await login(ow,t.email,S.PW); await ow.goto(BASE+'/admin/tables',{waitUntil:'networkidle'}); await ow.waitForTimeout(1200);
await ow.getByRole('button',{name:'Add Table'}).click(); await ow.getByPlaceholder('e.g. T13, OD05, VIP1').fill('OW1'); await ow.locator('button[type=submit]').filter({hasText:/add|create/i}).first().click(); await ow.waitForTimeout(1500); await shot(ow,'F-owner-no-override');
check('F16','a restaurant owner at the same limit is refused and is offered NO override control',/Plan limit reached/.test(await ow.locator('body').innerText())&&(await ow.getByTestId('override-open').count())===0);
const ownerAttempt=await S.call('POST','/tables',{token:t.token,body:{restaurantId:t.outlet.id,tableNumber:'OW2',limitOverrideReason:'owner trying to bypass the limit'}});
check('F17','the API refuses an owner who sends the override field anyway (403)',ownerAttempt.status===403&&ownerAttempt.code==='LIMIT_OVERRIDE_FORBIDDEN',`HTTP ${ownerAttempt.status}`);
// provisioning UI
const prov=await sa.goto(BASE+'/super-admin',{waitUntil:'networkidle'}); await sa.waitForTimeout(1500);
await sa.getByRole('button',{name:/Provision restaurant/}).first().click(); await sa.waitForTimeout(1200); await shot(sa,'F-provision-open');
fs.writeFileSync('/home/user/uat/resultsF_partial.json',JSON.stringify(results));
console.log(await sa.locator('input').evaluateAll(e=>e.map(x=>`${x.type}|${x.placeholder}|${x.name}|${x.id}`).slice(0,14)));
await browser.close(); fs.writeFileSync('/home/user/uat/resultsF.json',JSON.stringify(results)); process.exit(0)
