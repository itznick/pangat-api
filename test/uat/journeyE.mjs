import { chromium, newPage, login, shot, check, results, BASE } from './ui.mjs';
import * as S from './seed.mjs'; import fs from 'node:fs';
const st=JSON.parse(fs.readFileSync('/tmp/uat_state.json')); const pl=JSON.parse(fs.readFileSync('/tmp/uatBC_state.json'));
const adm=await S.adminToken(st.run+'f');
await S.db.query(`UPDATE organization_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code=$2),status='ACTIVE',current_period_end=now()+interval '30 days',cancel_at_period_end=false WHERE organization_id=$1`,[st.orgId,pl.withKds.code]);
// an in-flight order BEFORE expiry
const menu=(await S.call('GET',`/menu/public/${st.slug}`)).data; const it=menu.items[0];
const live=await S.call('POST','/orders',{headers:{'x-idempotency-key':'e-'+Math.random()},body:{restaurantSlug:st.slug,orderType:'DINE_IN',tableNumber:'T03',customerName:'Guest',consentAccepted:true,paymentMethod:'PAY_AT_COUNTER',items:[{menuItemId:it.id,name:it.name,price:Number(it.price),quantity:1}]}});
console.log('live order',live.status,live.data?.id);
const browser=await chromium.launch(); const p=await newPage(browser);
// expire through the platform API (it invalidates the access cache immediately)
const cx=await S.call('POST',`/admin/restaurants/${st.orgId}/subscription/cancel`,{token:adm.token,body:{immediate:true,reason:'UAT: simulate lapse of the subscription'}});
console.log('cancel',cx.status);
await login(p,st.email,S.PW); await p.waitForLoadState('networkidle');
check('E1','owner can still log in with an expired subscription',/\/admin/.test(p.url()),p.url().replace(BASE,''));
await p.goto(BASE+'/admin/subscription',{waitUntil:'networkidle'}); await p.waitForTimeout(1500); await shot(p,'E01-expired-billing');
const bt=await p.locator('body').innerText();
check('E2','billing page is reachable and shows the lapsed state',/Cancelled|Expired|Suspended/i.test(bt),(bt.match(/(Cancelled|Expired)[^\n]*/)||[''])[0]);
await p.goto(BASE+'/admin/tables',{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
await p.getByRole('button',{name:'Add Table'}).click(); await p.getByPlaceholder('e.g. T13, OD05, VIP1').fill('E99'); await p.locator('button[type=submit]').filter({hasText:/add|create/i}).first().click(); await p.waitForTimeout(1500); await shot(p,'E02-expired-add-table-blocked');
const et=await p.locator('body').innerText();
check('E3','adding a table is blocked with the subscription message',/subscription|renew|cancelled|expired/i.test(et)&&!(await S.db.query(`SELECT 1 FROM tables WHERE restaurant_id=$1 AND table_number='E99'`,[st.outletId])).rowCount,(et.match(/[^\n]*(cancelled|renew)[^\n]*/i)||[''])[0].slice(0,100));
await p.keyboard.press('Escape');
// settle the in-flight order from the UI
await p.goto(BASE+'/admin/orders',{waitUntil:'networkidle'}); await p.waitForTimeout(1800); await shot(p,'E03-expired-orders-list');
const rows=await p.getByText(/Mark (as )?paid|Settle|Collect/i).count(); console.log('settle controls',rows);
let settled=false;
const btn=p.getByRole('button',{name:/mark (as )?paid|settle|collect|confirm payment/i}).first();
if (await btn.isVisible().catch(()=>false)) { await btn.click(); await p.waitForTimeout(1200); const conf=p.getByRole('button',{name:/confirm|yes|settle|mark/i}).last(); if (await conf.isVisible().catch(()=>false)) await conf.click().catch(()=>{}); await p.waitForTimeout(1500); }
const paid=(await S.db.query(`SELECT payment_status FROM orders WHERE id=$1`,[live.data.id])).rows[0]?.payment_status; settled = paid==='PAID';
await shot(p,'E04-expired-after-settle');
check('E4','an in-flight order can still be settled while expired (UI)',settled,`payment_status=${paid}`);
// extend → restore
const ex=await S.call('POST',`/admin/restaurants/${st.orgId}/subscription/extend`,{token:adm.token,body:{days:30,reason:'UAT: payment received, restoring access'}});
await p.goto(BASE+'/admin/tables',{waitUntil:'networkidle'}); await p.waitForTimeout(1000);
await p.getByRole('button',{name:'Add Table'}).click(); await p.getByPlaceholder('e.g. T13, OD05, VIP1').fill('E98'); await p.locator('button[type=submit]').filter({hasText:/add|create/i}).first().click(); await p.waitForTimeout(1500); await shot(p,'E05-restored');
const ok=(await S.db.query(`SELECT 1 FROM tables WHERE restaurant_id=$1 AND table_number='E98'`,[st.outletId])).rowCount===1;
check('E5','extending the subscription restores access immediately',ex.status===200&&ok,`extend HTTP ${ex.status}; table created=${ok}`);
await browser.close(); fs.writeFileSync('/tmp/uatE_results.json',JSON.stringify(results)); process.exit(0)
