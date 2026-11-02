'use strict';
// 学习通（超星）作业自动化 CLI
//
//   node cli.js login                       # 打开浏览器，登录一次并导出登录态
//   node cli.js courses                     # 列出我的课程（含同名课程的多个班级）
//   node cli.js list  --course <url|id> --class <clazzid>
//   node cli.js dump  --chapter 3           # 把第3章题目导成 answers/ch3.json 模板
//   node cli.js fill  answers/ch3.json      # 只填不交
//   node cli.js submit answers/ch3.json     # 填 + 保存 + 提交
//   node cli.js score --chapter 3           # 查成绩与逐空对错
//   node cli.js redo  --chapter 3           # 重做（消耗一次重做机会）
const fs = require('fs');
const path = require('path');
const { launch, connect, pickPage } = require('./lib/browser');
const authLib = require('./lib/auth');
const dom = require('./lib/dom');

const HOST = 'https://mooc1.chaoxing.com';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

// ---------- 课程与列表 ----------

async function gotoCourses(page) {
  await page.goto(`${HOST}/visit/courses`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
}

// 直接 goto 作业列表会被判“长时间没有操作”，必须先走课程页再点“作业”tab
async function gotoWorkList(page, { course, clazz }) {
  if (!course || !clazz) throw new Error('需要 --course <courseId 或课程页 URL> 和 --class <clazzid>');
  const mid = `${HOST}/visit/stucoursemiddle?courseid=${course}&clazzid=${clazz}&vc=1`;
  await page.goto(mid, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => x.innerText.trim() === '作业');
    if (a) a.click();
  });
  await page.waitForTimeout(6000);
  if (!page.url().includes('getAllWork')) {
    throw new Error('没能进入作业列表，当前 URL: ' + page.url().slice(0, 120));
  }
}

async function readList(page) {
  return page.evaluate(dom.extractWorkList);
}

// 在列表页点第 N 章的“做作业/重做”，然后等作业页出现。
// 两种情况：
//   - 待做：点“做作业”会在新标签页打开 doHomeWorkNew
//   - 已完成：点“重做”只弹确认框，还要再点一次“重做”，才会打开作业页
async function openChapter(page, browser, chapter) {
  const before = new Set(browser.contexts()[0].pages().map((p) => p.url()));

  await page.evaluate((ch) => {
    const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const items = [...document.querySelectorAll('li')].filter((li) => {
      const t = norm(li.innerText);
      return /^第\s*\d+\s*章/.test(t) && t.length < 500;
    });
    const li = items.find((x) => norm(x.innerText).startsWith('第' + ch + '章'));
    if (!li) throw new Error('第 ' + ch + ' 章不存在');
    const a = [...li.querySelectorAll('a')].find((x) => /做作业|重做/.test(x.innerText));
    if (!a) throw new Error('第 ' + ch + ' 章没有可点击的作业入口');
    a.click();
  }, chapter);

  await page.waitForTimeout(2500);

  // 重做确认框（新版 .wouter / 旧版 #popok）
  const confirmed = await page.evaluate(() => {
    const w = document.querySelector('.wouter');
    if (w) {
      const btn = [...w.querySelectorAll('a')].find((a) => a.innerText.trim() === '重做');
      if (btn) {
        btn.click();
        return 'wouter';
      }
    }
    const ok = document.querySelector('#popok');
    if (ok) {
      ok.click();
      return 'popok';
    }
    return null;
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const dp = browser
      .contexts()[0]
      .pages()
      .find((p) => /doHomeWorkNew|doWork/.test(p.url()) && !before.has(p.url()));
    if (dp) {
      await dp.waitForLoadState('domcontentloaded').catch(() => {});
      await dp.waitForTimeout(2500);
      const n = await dp.evaluate(() => document.querySelectorAll('.TiMu').length);
      if (n > 0) return { page: dp, questions: n, confirmed };
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('没能打开作业页（' + (confirmed ? '已确认重做' : '未出现确认框') + '）');
}

// ---------- 命令 ----------

async function main() {
  const launched = await launch();
  const browser = await connect();
  const page = pickPage(browser);
  const restored = await authLib.restore(browser).catch((e) => ({ restored: false, reason: e.message }));

  if (cmd === 'login') {
    await authLib.save(page);
    await browser.close();
    return;
  }

  if (cmd === 'courses') {
    await gotoCourses(page);
    const rows = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a[href*="stucoursemiddle"], a[href*="studentcourse"]').forEach((a) => {
        const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        const u = new URL(a.href);
        out.push({
          title: t.slice(0, 60),
          courseId: u.searchParams.get('courseid') || u.searchParams.get('courseId'),
          clazzId: u.searchParams.get('clazzid') || u.searchParams.get('clazzid'),
        });
      });
      return out;
    });
    const seen = new Set();
    rows.forEach((r) => {
      const k = r.courseId + '/' + r.clazzId;
      if (seen.has(k)) return;
      seen.add(k);
      console.log(`${r.courseId}\t${r.clazzId}\t${r.title}`);
    });
    await browser.close();
    return;
  }

  // 其余命令都要求已在作业列表页（或能自己导航过去）
  const course = args.course || process.env.CX_COURSE;
  const clazz = args.class || process.env.CX_CLASS;

  if (cmd === 'list') {
    await gotoWorkList(page, { course, clazz });
    const rows = await readList(page);
    rows.forEach((r, i) => {
      console.log(
        `[${i + 1}] ${r.title}  status=${r.status} score=${r.score ?? '-'} ` +
          `workId=${r.workId ?? '-'} canRedo=${r.canRedo}`
      );
    });
    await browser.close();
    return;
  }

  const chapter = Number(args.chapter || args._[1]);
  const idx = chapter ? chapter - 1 : -1;

  if (cmd === 'redo') {
    await gotoWorkList(page, { course, clazz });
    const rows = await readList(page);
    const target = rows[idx];
    if (!target) throw new Error(`第 ${chapter} 章不存在`);
    if (!target.canRedo) throw new Error('该章没有重做机会了（[重做] 链接已消失）');
    const { page: dp, questions } = await openChapter(page, browser, chapter);
    console.log(`已重做第 ${chapter} 章，共 ${questions} 题。URL: ${dp.url().slice(0, 120)}`);
    await browser.close();
    return;
  }

  if (cmd === 'dump' || cmd === 'fill' || cmd === 'submit') {
    const inFile = args.file || args._[2];
    // 复用已打开的作业页，但必须确认就是本章——否则会填到别的章上
    let dp = browser.contexts()[0].pages().find((p) => /doHomeWorkNew|doWork/.test(p.url()));
    if (dp) {
      const onPage = await dp
        .evaluate(() => (document.body.innerText.match(/第\s*(\d+)\s*章/) || [])[1])
        .catch(() => null);
      if (String(onPage) !== String(chapter)) {
        console.log(`当前打开的作业页是第 ${onPage ?? '?'} 章，不是第 ${chapter} 章，重新打开...`);
        dp = null;
      }
    }
    if (!dp) {
      await gotoWorkList(page, { course, clazz });
      const rows = await readList(page);
      if (!rows[idx]) throw new Error(`第 ${chapter} 章不存在`);
      dp = (await openChapter(page, browser, chapter)).page;
    }
    const qs = await dp.evaluate(dom.extractQuestions);
    if (!qs.length) throw new Error('作业页上没有题目（页面可能还没加载完，或 DOM 结构变了）');
    const file = inFile || path.join(__dirname, 'answers', `ch${chapter}.json`);

    if (cmd === 'dump') {
      const tpl = {};
      qs.forEach((q) => {
        if (q.type === 'blank') tpl[q.n] = { blanks: new Array(q.blanks).fill('') };
        else tpl[q.n] = { choice: '' };
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(tpl, null, 2), 'utf8');
      console.log(`共 ${qs.length} 题，模板已写到 ${file}`);
      qs.forEach((q) => {
        console.log(`\n--- Q${q.n} [${q.type}] qid=${q.qid} blanks=${q.blanks}`);
        console.log(q.stem.slice(0, 400));
        q.imgs.forEach((u) => console.log('  IMG ' + u));
        q.options.forEach((o) => console.log(`   ${o.label} => ${o.text}`));
      });
      await browser.close();
      return;
    }

    const answers = JSON.parse(fs.readFileSync(file, 'utf8'));
    const log = [];
    for (const q of qs) {
      const a = answers[q.n];
      if (!a) {
        log.push(`Q${q.n} !! 缺答案，跳过`);
        continue;
      }
      if (a.choice) {
        const r = await dp.evaluate(dom.selectByText, [q.qid, a.choice]);
        log.push(`Q${q.n} ${r.ok ? '选中' : '!! 未选中(' + r.reason + ')'} ${r.text || a.choice}`);
      }
      if (a.blanks) {
        if (a.blanks.length !== q.blanks) {
          log.push(`Q${q.n} !! 空数不符 页面=${q.blanks} 答案=${a.blanks.length}`);
        }
        for (let k = 0; k < a.blanks.length; k++) {
          await dp.evaluate(dom.fillBlank, [q.qid, k + 1, a.blanks[k]]);
          log.push(`Q${q.n}.${k + 1} = ${a.blanks[k]}`);
        }
      }
    }
    log.forEach((l) => console.log(l));

    // 回读校验
    const back = await dp.evaluate(dom.readBack);
    const bad = back.filter((b) => {
      const a = answers[b.n];
      if (!a) return true;
      if (a.choice) return b.checked.length === 0;
      if (a.blanks) return b.blanks.some((x, i) => a.blanks[i] && x.text !== a.blanks[i]);
      return false;
    });
    if (bad.length) {
      console.log('\n!! 回读不一致：');
      bad.forEach((b) => console.log('  Q' + b.n, JSON.stringify(b)));
      if (cmd === 'submit') {
        console.log('已中止，未提交。');
        await browser.close();
        process.exit(2);
      }
    } else {
      console.log('\n回读校验通过');
    }

    if (cmd === 'fill') {
      console.log('（仅填写，未保存。要保存/提交请用 submit）');
      await browser.close();
      return;
    }

    // 保存 + 提交
    await dp.evaluate(dom.syncAll);
    let saveBody = null;
    let submitBody = null;
    dp.on('response', async (r) => {
      const u = r.url();
      if (!u.includes('addStudentWork')) return;
      const body = await r.text().catch(() => '');
      if (u.includes('saveStatus=1')) saveBody = body;
      else submitBody = body;
    });

    await dp.evaluate(() => {
      window.tempSave = false;
      if (window.saveWork) window.saveWork();
    });
    await dp.waitForTimeout(7000);
    console.log('\n保存响应:', saveBody);
    if (!saveBody || !/"status"\s*:\s*true/.test(saveBody)) {
      console.log('保存未成功，已中止。');
      await browser.close();
      process.exit(3);
    }

    await dp.evaluate(() => {
      window.confirm = () => true;
      window.alert = () => {};
      window.tempSave = false;
      window.submitLock = 0;
      if (window.noSubmit) window.noSubmit();
    });
    await dp.waitForTimeout(3000);
    await dp.evaluate(() => {
      const ok = [...document.querySelectorAll('#confirmSubWin a')].find((a) => /确定/.test(a.innerText));
      if (ok) ok.click();
    });
    await dp.waitForTimeout(9000);
    console.log('提交响应:', submitBody);
    console.log('已提交。用 `node cli.js score --chapter ' + chapter + '` 看成绩。');
    await browser.close();
    return;
  }

  if (cmd === 'score') {
    await gotoWorkList(page, { course, clazz });
    const rows = await readList(page);
    const target = rows[idx];
    if (!target) throw new Error(`第 ${chapter} 章不存在`);
    if (!target.viewHref) throw new Error('还没提交过，没有成绩页');
    await page.goto(HOST + target.viewHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    const detail = await page.evaluate(() => {
      const txt = document.body.innerText;
      const score = (txt.match(/成绩：\s*([\d.]+)\s*分/) || [])[1];
      const marks = [...document.querySelectorAll('.Py_answer')].map((el, i) => ({
        q: i + 1,
        wrong: el.querySelectorAll('.fr.cuo').length,
        right: el.querySelectorAll('.fr.dui').length,
        items: [...el.querySelectorAll('.font14')].map((d) => ({
          label: (d.querySelector('i') || {}).innerText || '',
          text: (d.querySelector('p') || {}).innerText || '',
          ok: !!d.querySelector('.dui'),
        })),
      }));
      return { score, marks };
    });
    console.log('成绩:', detail.score, '分');
    detail.marks.forEach((m) => {
      const tag = m.wrong ? '✗' : '✓';
      const items = m.items.filter((x) => x.text).map((x) => `${x.text}${x.ok ? '✓' : '✗'}`).join(' | ');
      if (m.wrong || items) console.log(`${tag} Q${m.q}  ${items}`);
    });
    await browser.close();
    return;
  }

  console.log(`用法:
  node cli.js login
  node cli.js courses
  node cli.js list   --course <courseId> --class <clazzId>
  node cli.js dump   --course .. --class .. --chapter 3
  node cli.js fill   --course .. --class .. --chapter 3 [--file answers/ch3.json]
  node cli.js submit --course .. --class .. --chapter 3 [--file answers/ch3.json]
  node cli.js score  --course .. --class .. --chapter 3
  node cli.js redo   --course .. --class .. --chapter 3`);
  await browser.close();
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
