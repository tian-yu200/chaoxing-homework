'use strict';
// 启动 / 连接一个带远程调试端口的独立 Edge（不影响日常浏览器）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.CX_PORT || 9223);
const PROFILE = process.env.CX_PROFILE || path.join(__dirname, '..', '.edge-profile');

function findBrowser() {
  if (process.env.CX_BROWSER) return process.env.CX_BROWSER;
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return cands.find((p) => fs.existsSync(p));
}

function waitPort(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(d));
        })
        .on('error', () => {
          if (Date.now() > deadline) return reject(new Error('CDP port not ready'));
          setTimeout(tick, 500);
        });
    };
    tick();
  });
}

async function launch() {
  try {
    await waitPort(1500);
    return { already: true, port: PORT };
  } catch (_) {}
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Edge/Chrome，请用 CX_BROWSER 指定可执行文件路径');
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  await waitPort();
  return { already: false, port: PORT, exe };
}

async function connect() {
  const { chromium } = require('playwright-core');
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 60000 });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

// 拿一个可用的 page（优先学习通页面；跳过已关闭/卡死的页）
function pickPage(browser, { prefer = 'chaoxing' } = {}) {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages().filter((p) => {
    try {
      return !p.isClosed();
    } catch (_) {
      return false;
    }
  });
  const http = pages.filter((p) => /^https?:/.test(p.url()));
  return (
    http.find((p) => p.url().includes(prefer)) ||
    http.find((p) => !p.url().includes('yuntihai')) ||
    pages.find((p) => !p.url().startsWith('devtools')) ||
    null
  );
}

module.exports = { PORT, PROFILE, launch, connect, pickPage, findBrowser };
