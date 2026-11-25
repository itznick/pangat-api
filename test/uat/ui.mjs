import pw from '/opt/node-tools/node_modules/playwright/index.js';
export const { chromium } = pw;
export const SHOTS='/home/user/uat-screenshots';
export const BASE='http://127.0.0.1:5173';
export async function newPage(browser,w=1366,h=850){const ctx=await browser.newContext({viewport:{width:w,height:h}});const p=await ctx.newPage();p.on('pageerror',e=>console.log('  PAGEERROR',e.message.slice(0,200)));return p}
export async function login(p,email,password){await p.goto(BASE+'/login',{waitUntil:'networkidle'});await p.waitForSelector('input[type=email]',{timeout:60000});await p.fill('input[type=email]',email);await p.fill('input[type=password]',password);await p.getByRole('button',{name:/^sign in$/i}).click();await p.waitForURL(/\/admin|\/super-admin|\/change-password/,{timeout:30000})}
export const shot=(p,name)=>p.screenshot({path:`${SHOTS}/${name}.png`});
export const results=[];
export function check(id,desc,ok,evidence=''){results.push({id,desc,ok:!!ok,evidence});console.log(`${ok?'PASS':'FAIL'}  ${id}  ${desc}${evidence?'  ['+evidence+']':''}`)}
