import { chromium, newPage, login, shot, check, results, BASE } from './ui.mjs';
import * as S from './seed.mjs'; import fs from 'node:fs';
const st=JSON.parse(fs.readFileSync('/tmp/uat_state.json'));
const withKds=await S.makePlan({token:(await S.adminToken(st.run+'b')).token},st.run+'b','kds',{outlets:1,tables:10,staff:5,features:['QR_ORDERING','KDS']});
const noKds=await S.makePlan({token:(await S.adminToken(st.run+'c')).token},st.run+'c','nokds',{outlets:1,tables:10,staff:5,features:['QR_ORDERING']});
const noQr=await S.makePlan({token:(await S.adminToken(st.run+'d')).token},st.run+'d','noqr',{outlets:1,tables:10,staff:5,features:['KDS']});
const setPlan=(plan)=>S.db.query(`UPDATE organization_subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code=$2) WHERE organization_id=$1`,[st.orgId,plan.code]);
await setPlan(withKds);
const browser=await chromium.launch();
// ── C: diner (QR menu) ────────────────────────────────────────────────────────
const d=await newPage(browser,420,900);
await d.goto(`${BASE}/r/${st.slug}/t/T01`,{waitUntil:'networkidle'}); await d.waitForTimeout(1500); await shot(d,'C01-diner-menu');
const menuTxt=await d.locator('body').innerText();
check('C1','public QR menu opens without login and lists dishes',/Misal|Poha|Chai|Maska/i.test(menuTxt),(menuTxt.match(/Bun Maska[^\n]*/)||menuTxt.slice(0,60))[0]);
// add first item and open checkout
const addBtns=d.getByRole('button',{name:/^add/i}); console.log('add buttons',await addBtns.count());
await addBtns.first().click().catch(async()=>{ await d.locator('button:has-text("Add")').first().click() }); await d.waitForTimeout(700);
await shot(d,'C02-diner-item-added');
console.log((await d.getByRole('button').allInnerTexts()).filter(t=>t.trim()).slice(0,25).join(' | '));
await browser.close(); fs.writeFileSync('/tmp/uatBC_state.json',JSON.stringify({withKds,noKds,noQr})); process.exit(0)
