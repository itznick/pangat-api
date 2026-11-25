import { chromium, newPage, login, shot, check, results, BASE } from './ui.mjs'; import * as S from './seed.mjs'; import fs from 'node:fs';
const run=Math.random().toString(36).slice(2,6); const admin=await S.adminToken(run);
const kds=await S.makePlan(admin,run,'kds',{outlets:1,tables:10,staff:5,features:['QR_ORDERING','KDS']});
const nokds=await S.makePlan(admin,run,'nokds',{outlets:1,tables:10,staff:5,features:['QR_ORDERING']});
const o=await S.onboard(run,'h',kds,{indoorTableCount:3});
const browser=await chromium.launch();
const k=await newPage(browser); await k.goto(BASE+'/login?tab=pin',{waitUntil:'networkidle'}); await k.waitForSelector('#slug'); await k.fill('#slug',o.slug); await k.fill('#pin','2468'); await k.getByRole('button',{name:/Open kitchen display/i}).click(); await k.waitForURL(/\/kds\//); await k.waitForTimeout(2500);
const owner=await newPage(browser); await login(owner,o.email,S.PW); await owner.goto(BASE+'/admin/orders',{waitUntil:'networkidle'}); await owner.waitForTimeout(1500);
const order=async()=>{ const m=(await S.call('GET',`/menu/public/${o.slug}`)).data.items[0]; return S.call('POST','/orders',{headers:{'x-idempotency-key':'h-'+Math.random()},body:{restaurantSlug:o.slug,orderType:'TAKEAWAY',customerName:'Guest',consentAccepted:true,paymentMethod:'PAY_AT_COUNTER',items:[{menuItemId:m.id,name:m.name,price:Number(m.price),quantity:1}]}}) };
await order(); await k.waitForTimeout(2000); const before=await k.locator('button:has-text("Start Prep")').count(); await shot(k,'H01-kds-live');
check('H1','the kitchen board is live and shows the new ticket',before>0,`Start Prep buttons=${before}`);
const ch=await S.call('POST',`/admin/restaurants/${o.orgId}/subscription/change-plan`,{token:admin.token,body:{planCode:nokds.code,reason:'UAT: KDS removed while the kitchen screen is open'}});
let shown=false; for(let i=0;i<30&&!shown;i++){ await k.waitForTimeout(500); shown=/kitchen display is not included/i.test(await k.locator('body').innerText()); }
await shot(k,'H02-kds-revoked-notice');
check('H2','with the KDS screen already open, losing KDS replaces the board with the notice (no reload)',ch.status===200&&shown);
const ownerTxt=await owner.evaluate(()=>document.body.innerText); 
await order(); await owner.waitForTimeout(2500); await shot(owner,'H03-owner-orders-still-live');
const ownerCount=await owner.locator('body').innerText();
check('H3','the owner\'s Orders screen keeps working and still receives the new order live',/Orders/i.test(ownerCount)&&(await S.db.query(`SELECT COUNT(*) FROM orders WHERE restaurant_id=$1`,[o.outlet.id])).rows[0].count==='2');
await S.call('POST',`/admin/restaurants/${o.orgId}/subscription/change-plan`,{token:admin.token,body:{planCode:kds.code,reason:'UAT: KDS restored'}});
let back=false; for(let i=0;i<110&&!back;i++){ await k.waitForTimeout(500); back=/New Orders/i.test(await k.locator('body').innerText())&&!/kitchen display is not included/i.test(await k.locator('body').innerText()); }
await shot(k,'H04-kds-restored');
check('H4','when KDS is restored the open kitchen screen recovers by itself (within its 30 s re-check)',back);
const n0=await k.locator('button:has-text("Start Prep")').count(); await order(); await k.waitForTimeout(3000);
check('H5','and receives new orders live again after reconnecting',(await k.locator('button:has-text("Start Prep")').count())>n0,`${n0}->${await k.locator('button:has-text("Start Prep")').count()}`);
fs.writeFileSync('/home/user/uat/resultsH.json',JSON.stringify(results)); await browser.close(); process.exit(0)
