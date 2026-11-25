import { chromium, newPage, login, shot, check, results, BASE } from './ui.mjs';
import * as S from './seed.mjs'; import fs from 'node:fs';
const st=JSON.parse(fs.readFileSync('/tmp/uat_state.json')); const pl=JSON.parse(fs.readFileSync('/tmp/uatBC_state.json'));
const adm=await S.adminToken(st.run+'e');
const setPlan=(plan)=>S.db.query(`UPDATE organization_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code=$2),status='ACTIVE',current_period_end=now()+interval '30 days',cancel_at_period_end=false WHERE organization_id=$1`,[st.orgId,plan.code]);
const orderCount=async()=> Number((await S.db.query('SELECT COUNT(*) FROM orders WHERE restaurant_id=$1',[st.outletId])).rows[0].count);
await setPlan(pl.withKds);
const browser=await chromium.launch();
async function dinerOrder(page,table='T01'){ await page.goto(`${BASE}/r/${st.slug}/t/${table}`,{waitUntil:'networkidle'}); await page.waitForTimeout(1200);
  await page.getByRole('button',{name:/^add/i}).first().click(); await page.waitForTimeout(400); await page.getByText('Tap to review order').click(); await page.waitForTimeout(800);
  await page.getByText('Pay at Counter').first().click(); await page.waitForTimeout(300);
  await page.getByRole('button',{name:/Place order|Confirm|Send to kitchen|Proceed/i}).last().click(); await page.waitForTimeout(2500); }
// ── C2: normal order journey ──────────────────────────────────────────────────
const d=await newPage(browser,420,900); const before=await orderCount();
await dinerOrder(d); await shot(d,'C03-diner-after-order');
const after=await orderCount();
check('C2','diner places a normal order from the QR menu (QR_ORDERING enabled)',after===before+1&&/\/order\//.test(d.url()),`orders ${before}->${after}; url ${d.url().replace(BASE,'')}`);
// ── B: kitchen ───────────────────────────────────────────────────────────────
const k=await newPage(browser,1366,850);
await k.goto(BASE+'/login?tab=pin',{waitUntil:'networkidle'}); await k.waitForSelector('#slug',{timeout:60000}); await k.fill('#slug',st.slug); await k.fill('#pin','2468');
await k.getByRole('button',{name:/Open kitchen display/i}).click(); await k.waitForURL(/\/kds\//,{timeout:30000}); await k.waitForTimeout(2500); await shot(k,'B01-kds-after-pin-login');
check('B1','kitchen PIN login opens the KDS',/\/kds\//.test(k.url()),k.url().replace(BASE,''));
const kt=await k.locator('body').innerText();
check('B2','the earlier order is visible as a ticket in New Orders',/New Orders/i.test(kt)&&/T01|Bun Maska/i.test(kt),'ticket present');
// live: second order arrives without reload
const d2=await newPage(browser,420,900); const t0=await k.locator('button:has-text("Start Prep")').count();
await dinerOrder(d2,'T02'); await k.waitForTimeout(2500); await shot(k,'B02-kds-live-new-order');
const t1=await k.locator('button:has-text("Start Prep")').count();
check('B3','a new guest order appears on the KDS live (no reload; the board renders each ticket in a desktop and a mobile column)',t1>t0,`Start Prep buttons ${t0}->${t1}`);
const readyBefore=Number((await S.db.query(`SELECT COUNT(*) FROM orders WHERE restaurant_id=$1 AND order_status='READY'`,[st.outletId])).rows[0].count);
await k.locator('button:has-text("Start Prep")').first().click(); await k.waitForTimeout(1500);
await k.locator('button:has-text("Mark Ready")').first().click(); await k.waitForTimeout(1500); await shot(k,'B03-kds-status-changed');
const sts=(await S.db.query(`SELECT order_status, COUNT(*) FROM orders WHERE restaurant_id=$1 GROUP BY 1`,[st.outletId])).rows.map(r=>`${r.order_status}:${r.count}`).join(', ');
const readyAfter=Number((await S.db.query(`SELECT COUNT(*) FROM orders WHERE restaurant_id=$1 AND order_status='READY'`,[st.outletId])).rows[0].count);
check('B4','kitchen advances an order Start Prep -> Mark Ready (persisted)',readyAfter===readyBefore+1,`READY ${readyBefore}->${readyAfter}; all: ${sts}`);
// KDS switched off for the plan
await setPlan(pl.noKds); await k.reload({waitUntil:'networkidle'}); await k.waitForTimeout(2500); await shot(k,'B04-kds-disabled');
const kt2=await k.locator('body').innerText();
check('B5','with KDS not in the plan the KDS shows the upgrade notice instead of the board',/kitchen display is not included/i.test(kt2),(kt2.match(/The kitchen display[^\n]*/)||[''])[0].slice(0,90));
const k2=await newPage(browser); await k2.goto(BASE+'/login?tab=pin',{waitUntil:'networkidle'}); await k2.waitForSelector('#slug'); await k2.fill('#slug',st.slug); await k2.fill('#pin','2468'); await k2.getByRole('button',{name:/Open kitchen display/i}).click(); await k2.waitForTimeout(2000); await shot(k2,'B05-pin-login-refused');
check('B6','a fresh kitchen PIN sign-in is refused with a clear message when KDS is not in the plan',!/\/kds\//.test(k2.url())&&/kitchen display|plan/i.test(await k2.locator('body').innerText()),(await k2.locator('body').innerText()).match(/Your current plan[^\n]*/)?.[0]||'');
// ── C3: ordering disabled ───────────────────────────────────────────────────────
await setPlan(pl.noQr); await new Promise(r=>setTimeout(r,3500));
const d3=await newPage(browser,420,900); await d3.goto(`${BASE}/r/${st.slug}/t/T01`,{waitUntil:'networkidle'}); await d3.waitForTimeout(1500); await shot(d3,'C04-diner-ordering-closed');
const ct=await d3.locator('body').innerText();
check('C3','with QR_ORDERING off the menu still opens but ordering is shown as closed, clearly',/not taking orders/i.test(ct),(ct.match(/[^\n]*not taking orders[^\n]*/)||[''])[0]);
const api=await S.call('POST','/orders',{headers:{'x-idempotency-key':'uat-'+Math.random()},body:{restaurantSlug:st.slug,orderType:'TAKEAWAY',customerName:'G',consentAccepted:true,paymentMethod:'PAY_AT_COUNTER',items:[{menuItemId:(await S.call('GET',`/menu/public/${st.slug}`)).data.items[0].id,name:'x',price:45,quantity:1}]}});
check('C4','a direct API order is refused too',api.status===400,`HTTP ${api.status}`);
await browser.close(); fs.writeFileSync('/tmp/uatBCE_results.json',JSON.stringify(results)); process.exit(0)
