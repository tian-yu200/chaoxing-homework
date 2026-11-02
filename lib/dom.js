'use strict';
// 学习通作业页解析与操作。
//
// 重要：这里每个函数都会被 page.evaluate(fn) 序列化后丢进浏览器执行。
// 序列化只保留函数体，模块作用域里的变量不会被带过去，
// 所以每个函数内部都必须自包含（工具函数重复定义在函数体里）。
//
// 兼容两代 DOM：
//   新版 doHomeWorkNew: .TiMu / input[name=answer<qid>] / textarea#answerEditor<qid><n>
//   旧版 doWork:        .questionLi / .answerBg / .answer_p / .Answer

const HOST = 'https://mooc1.chaoxing.com';

// 从作业列表页提取每章条目（含 workId / workAnswerId / 状态 / 分数）
function extractWorkList() {
  const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const items = [...document.querySelectorAll('li')].filter((li) => {
    const t = norm(li.innerText);
    return /^第\s*\d+\s*章/.test(t) && t.length < 500;
  });
  return items.map((li) => {
    const t = norm(li.innerText);
    const redo = [...li.querySelectorAll('a')].find((a) => /重做/.test(a.innerText));
    const doIt = [...li.querySelectorAll('a')].find((a) => /做作业/.test(a.innerText));
    const view = [...li.querySelectorAll('a')].find((a) => /^查看$/.test(a.innerText.trim()));
    const act = redo || doIt;
    const score = (t.match(/(\d+(?:\.\d+)?)\s*分/) || [])[1];
    return {
      title: (t.match(/^第\s*\d+\s*章[^开]*/) || [t])[0].trim(),
      status: /已完成/.test(t) ? 'done' : /待做/.test(t) ? 'todo' : /未开始/.test(t) ? 'locked' : '?',
      score: score ? Number(score) : null,
      canRedo: !!redo,
      workId: act ? act.getAttribute('data') : null,
      workAnswerId: act ? act.getAttribute('data2') : null,
      viewHref: view ? view.getAttribute('href') : null,
    };
  });
}

// 点第 N 章的“做作业 / 重做”链接（在列表页调用）
function clickChapter(ch) {
  const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const items = [...document.querySelectorAll('li')].filter((li) => {
    const t = norm(li.innerText);
    return /^第\s*\d+\s*章/.test(t) && t.length < 500;
  });
  const li = items.find((x) => norm(x.innerText).startsWith('第' + ch + '章'));
  if (!li) return { ok: false, reason: 'chapter not found' };
  const a = [...li.querySelectorAll('a.inspectTask')].find((x) => /做作业|重做/.test(x.innerText));
  if (!a) return { ok: false, reason: 'no action link' };
  a.click();
  return { ok: true, workId: a.getAttribute('data'), workAnswerId: a.getAttribute('data2') };
}

// 点第 N 章的 [重做]（在列表页调用）
function clickRedo(ch) {
  const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const items = [...document.querySelectorAll('li')].filter((li) => {
    const t = norm(li.innerText);
    return /^第\s*\d+\s*章/.test(t) && t.length < 500;
  });
  const li = items.find((x) => norm(x.innerText).startsWith('第' + ch + '章'));
  if (!li) return { ok: false, reason: 'chapter not found' };
  const a = [...li.querySelectorAll('a')].find((x) => /重做/.test(x.innerText));
  if (!a) return { ok: false, reason: 'no redo link（重做次数已用完）' };
  a.click();
  return { ok: true };
}

// 确认重做弹窗：新版是 .wouter 里的“重做”，旧版是 #popok
function confirmRedo() {
  const w = document.querySelector('.wouter');
  if (w) {
    const btn = [...w.querySelectorAll('a')].find((a) => a.innerText.trim() === '重做');
    if (btn) {
      const txt = (w.innerText || '').replace(/\s+/g, ' ').trim();
      btn.click();
      return { ok: true, via: 'wouter', text: txt.slice(0, 200) };
    }
  }
  const ok = document.querySelector('#popok');
  if (ok) {
    ok.click();
    return { ok: true, via: 'popok' };
  }
  return { ok: false, reason: 'no confirm dialog' };
}

// 读题（新版 DOM）
function extractQuestions() {
  const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('.TiMu')].map((li, i) => {
    const qid = li.getAttribute('data');
    const titleEl = li.querySelector('.Zy_TItle .fontLabel') || li.querySelector('.Zy_TItle');
    const inputs = [...li.querySelectorAll('input[name="answer' + qid + '"]')];
    const type = inputs.length ? (inputs[0].type === 'radio' ? 'single' : 'multi') : 'blank';
    const tk = li.querySelector('input[name^="tiankongsize"]');
    return {
      n: i + 1,
      qid,
      type,
      stem: norm(titleEl ? titleEl.innerText : '').slice(0, 2000),
      stemHtml: (titleEl ? titleEl.innerHTML : '').slice(0, 4000),
      imgs: [...li.querySelectorAll('.Zy_TItle img')].map((im) => im.src),
      options: [...li.querySelectorAll('.Zy_ulTop li')].map((x) => {
        const inp = x.querySelector('input');
        const a = x.querySelector('a.after');
        return {
          value: inp ? inp.value : '',
          checked: inp ? inp.checked : false,
          label: norm((x.querySelector('label') || {}).innerText).replace(/[\s\u00a0]+/g, '').slice(-1) || '',
          text: norm(a ? a.innerText : ''),
        };
      }),
      blanks: tk ? Number(tk.value) : 0,
      taIds: [...li.querySelectorAll('textarea')].map((t) => t.id),
    };
  });
}

// 按选项文本选中（不依赖字母，选项顺序每次刷新都会变）
// 兼容 page.evaluate(fn, [qid, want]) 和直接调用两种形式
function selectByText(a, b) {
  const [qid, want] = Array.isArray(a) ? a : [a, b];
  const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const li = document.querySelector('.TiMu[data="' + qid + '"]');
  if (!li) return { ok: false, reason: 'no question' };
  const opts = [...li.querySelectorAll('.Zy_ulTop li')].map((x) => ({
    inp: x.querySelector('input'),
    text: norm((x.querySelector('a.after') || {}).innerText),
  }));
  const wantNorm = norm(want);
  let hits = opts.filter((o) => o.text === wantNorm);
  if (hits.length !== 1) hits = opts.filter((o) => o.text.includes(wantNorm));
  if (hits.length !== 1) return { ok: false, reason: 'matched ' + hits.length };
  const inp = hits[0].inp;
  if (!inp.checked) inp.click();
  // 点击是 toggle 语义，若仍没选中则强制置位
  if (!inp.checked) {
    inp.checked = true;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { ok: inp.checked, value: inp.value, text: hits[0].text };
}

// 写填空。必须 HTML 转义：答案里的 < > & 会被 UEditor 当标签解析掉。
function fillBlank(a, b, c) {
  const [qid, index1, value] = Array.isArray(a) ? a : [a, b, c];
  const id = 'answerEditor' + qid + index1;
  const ta = document.getElementById(id);
  if (!ta) return { ok: false, reason: 'no editor ' + id };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<p>' + esc(value) + '</p>';
  const ed = window.UE && window.UE.getEditor(id);
  if (ed && ed.setContent) ed.setContent(html, false);
  else ta.value = html;
  return { ok: true };
}

// 回读：每题的选中项 / 每空的编辑器文本
function readBack() {
  return [...document.querySelectorAll('.TiMu')].map((li, i) => {
    const qid = li.getAttribute('data');
    const checked = [...li.querySelectorAll('input[name="answer' + qid + '"]')]
      .filter((x) => x.checked)
      .map((x) => x.value);
    const blanks = [...li.querySelectorAll('textarea')].map((t) => {
      let txt = '';
      try {
        const ed = window.UE && window.UE.getEditor(t.id);
        txt = ed ? ed.getPlainTxt().trim() : t.value;
      } catch (_) {
        txt = t.value;
      }
      return { id: t.id, text: txt, hidden: t.value };
    });
    return { n: i + 1, qid, checked, blanks };
  });
}

// 把所有编辑器内容 sync 进 hidden input（提交前必做）
function syncAll() {
  const ids = [...document.querySelectorAll('.TiMu')].map((li) => li.getAttribute('data'));
  const box = document.querySelector('#answerwqbid');
  if (box) box.value = ids.map((i) => i + ',').join('');
  ids.forEach((id) => {
    const t = document.querySelector('#answertype' + id);
    try {
      window.syncAnswer(id, t ? t.value : '0');
    } catch (_) {}
  });
  ['setMultiChoiceAnswer', 'setConnLineAnswer', 'setSortQuesAnswer', 'setCompoundQuesAnswer'].forEach((fn) => {
    try {
      if (typeof window[fn] === 'function') window[fn]();
    } catch (_) {}
  });
  return ids.length;
}

// 读成绩页：总分 + 每空对错（<i class="fr dui|cuo">）
function extractScore() {
  const txt = document.body.innerText;
  const score = (txt.match(/成绩：\s*([\d.]+)\s*分/) || [])[1];
  const marks = [...document.querySelectorAll('.Py_answer')].map((el, i) => ({
    q: i + 1,
    wrong: el.querySelectorAll('.fr.cuo').length,
    right: el.querySelectorAll('.fr.dui').length,
    items: [...el.querySelectorAll('.font14')].map((d) => ({
      label: ((d.querySelector('i') || {}).innerText || '').trim(),
      text: ((d.querySelector('p') || {}).innerText || '').trim(),
      ok: !!d.querySelector('.dui'),
    })),
  }));
  return { score: score ? Number(score) : null, marks };
}

module.exports = {
  HOST,
  extractWorkList,
  clickChapter,
  clickRedo,
  confirmRedo,
  extractQuestions,
  selectByText,
  fillBlank,
  readBack,
  syncAll,
  extractScore,
};
