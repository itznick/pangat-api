import { chromium, newPage, shot, check, results, BASE } from './ui.mjs'; import * as S from './seed.mjs'; import fs from 'node:fs';
const run=Math.random().toString(36).slice(2,6); const admin=await S.adminToken(run);
const b=await chromium.launch(); const sa=await newPage(b);
await sa.goto(BASE+'/login',{waitUntil:'networkidle'}); await sa.waitForSelector('input[type=email]'); await sa.fill('input[type=email]',admin.email); await sa.fill('input[type=password]',S.PW); await sa.getByRole('button',{name:/^sign in$/i}).click(); await sa.waitForURL(/super-admin/);
await sa.getByRole('button',{name:/Provision restaurant/}).first().click(); await sa.waitForTimeout(1000);
await sa.getByPlaceholder('Roast & Toast Cafe').fill(`UAT Prov ${run}`); await sa.getByPlaceholder('Rohan Deshmukh').fill('Prov Owner'); await sa.getByPlaceholder('98900 12345').fill('9890012345'); await sa.getByPlaceholder('owner@brand.in').fill(`prov-${run}@example.com`);
await sa.getByRole('button',{name:/Continue/}).click(); await sa.waitForTimeout(700);
console.log('STEP1', JSON.stringify(await sa.locator('input:visible').evaluateAll(e=>e.map(x=>`${x.type}|${x.placeholder}|${x.value}`))));
await sa.getByRole('button',{name:/Continue/}).click(); await sa.waitForTimeout(700);
console.log('STEP2', JSON.stringify(await sa.locator('input:visible').evaluateAll(e=>e.map(x=>`${x.type}|${x.placeholder}|${x.value}|${x.min}|${x.max}`))));
const nums=sa.locator('input[type=number]:visible'); await nums.nth(0).fill('40'); await nums.nth(1).fill('10');
await sa.getByRole('button',{name:/Continue/}).click(); await sa.waitForTimeout(700);
while (await sa.getByRole('button',{name:/Continue/}).isVisible().catch(()=>false)) { await sa.getByRole('button',{name:/Continue/}).click(); await sa.waitForTimeout(600); }
await shot(sa,'G-final-step');
await sa.getByRole('button',{name:/Provision restaurant/}).last().click(); await sa.waitForTimeout(2500); await shot(sa,'G-limit-refused');
const t1=await sa.locator('body').innerText();
check('G1','provisioning 50 tables on a 40-table trial plan is refused with the limit message',/Plan limit reached|asked for 50|allows 40/i.test(t1),(t1.match(/[^\n]*(allows 40|Plan limit)[^\n]*/)||[''])[0].slice(0,120));
check('G2','the Super Admin sees the audited-exception control',await sa.getByTestId('override-open').isVisible());
const ex=(await S.db.query(`SELECT 1 FROM organizations WHERE name=$1`,[`UAT Prov ${run}`])).rowCount; check('G3','nothing was created by the refused attempt',ex===0);
await sa.getByTestId('override-open').click(); await sa.waitForTimeout(400);
await sa.getByTestId('override-reason').fill('Pilot chain with a 50-table banquet floor, founder approved'); await sa.getByTestId('override-ack').check(); await shot(sa,'G-override-dialog');
await sa.getByRole('button',{name:'Apply exception'}).click(); await sa.waitForTimeout(3500); await shot(sa,'G-provisioned');
const org=(await S.db.query(`SELECT id FROM organizations WHERE name=$1`,[`UAT Prov ${run}`])).rows[0];
let tables=0, aud=null; if(org){ tables=Number((await S.db.query(`SELECT COUNT(*) FROM tables t JOIN restaurants r ON r.id=t.restaurant_id WHERE r.organization_id=$1`,[org.id])).rows[0].count); aud=(await S.db.query(`SELECT changes,reason,actor_email FROM platform_audit_logs WHERE organization_id=$1 AND action='PLAN_LIMIT_OVERRIDDEN'`,[org.id])).rows[0]; }
check('G4','after the confirmed exception the restaurant is provisioned with its 50 tables',tables===50,`tables=${tables}`);
check('G5','the audit record shows tables, limit 40, current 0, requested 50, the actor and the reason',aud&&aud.changes.kind==='tables'&&aud.changes.limit===40&&aud.changes.current===0&&aud.changes.adding===50&&aud.actor_email===admin.email&&/banquet/.test(aud.reason),JSON.stringify(aud?.changes));
fs.writeFileSync('/home/user/uat/resultsG.json',JSON.stringify(results)); await b.close(); process.exit(0)
