'use strict';
// 登录态导出 / 恢复。
// 学习通的 _uid / uf / _d 是 session cookie，浏览器关闭即失效，
// 所以必须导出到 auth.json，下次启动时由 restore() 注入。
const fs = require('fs');
const path = require('path');

const AUTH = process.env.CX_AUTH || path.join(__dirname, '..', 'auth.json');
const CHECK_URL = 'https://i.chaoxing.com/base';
const CORE = ['_uid', 'uf', '_d'];

function hasAuth() {
  return fs.existsSync(AUTH);
}

async function status(page) {
  const ck = await page.context().cookies('https://i.chaoxing.com');
  const names = new Set(ck.map((c) => c.name));
  const hasCore = CORE.some((n) => names.has(n));
  const onLogin = /passport2\.chaoxing\.com\/login/.test(page.url());
  return { ok: hasCore && !onLogin, hasCore, onLogin, url: page.url(), names: [...names] };
}

// 从当前浏览器导出 cookie。若未登录，会等待用户手动登录（最多 waitMs）。
async function save(page, { waitMs = 300000 } = {}) {
  await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  let st = await status(page);
  if (!st.ok) {
    console.log('尚未登录，请在弹出的浏览器窗口里完成登录（最多等 5 分钟）...');
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      st = await status(page);
      if (st.ok) break;
    }
  }
  if (!st.ok) {
    throw new Error('未登录，当前 cookie: ' + st.names.join(' '));
  }

  const state = await page.context().storageState();
  fs.writeFileSync(AUTH, JSON.stringify(state, null, 1));
  console.log(`已保存 ${state.cookies.length} 条 cookie 到 ${AUTH}`);
  return state;
}

// 注入 auth.json 里的 cookie。
// 关键：expires === -1 表示 session cookie，必须删掉 expires 字段，
// 否则 Playwright addCookies 会直接抛错。
async function restore(browser) {
  if (!hasAuth()) return { restored: false, reason: 'auth.json 不存在' };
  const state = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
  const cookies = (state.cookies || []).map((c) => {
    const { expires, ...rest } = c;
    if (expires === -1 || expires === undefined) return rest;
    return { ...rest, expires };
  });
  const ctx = browser.contexts()[0];
  await ctx.addCookies(cookies);
  return { restored: true, count: cookies.length };
}

module.exports = { AUTH, CORE, save, restore, status, hasAuth };
