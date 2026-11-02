# chaoxing-homework

学习通（超星）作业自动化工具。用 CDP 驱动一个独立的 Edge/Chrome，把「重做 → 读题 → 填答案 → 回读校验 → 保存 → 提交 → 验分」整条链路做完，并在提交后逐空告诉你哪一空错了。

不是「自动答题器」——它不猜答案。答案由你（或你的 AI agent）准备好写进 JSON，工具只负责把答案**准确地**填进页面并验证。

## 它解决的具体问题

学习通作业页有几个非常容易踩的坑，这个仓库把它们都处理了：

| 坑 | 后果 | 这里的处理 |
|---|---|---|
| **选项顺序每次刷新都打乱** | 按 A/B/C/D 填必错 | 一律按**选项文本**匹配，先完全相等，再退化到唯一子串，匹配不唯一就跳过不填 |
| **点击是 toggle 语义** | 已选中的选项再点一次会取消 | 填完立即回读 `input.checked`，不对就补点 |
| **UEditor 填空按 DOM 顺序取 textarea 会串位** | 多空题答案错位 | 用 `answerEditor<qid><n>` 精确定位每个空，空数从 `tiankongsize<qid>` 读 |
| **答案里的 `<` `>` `&` 被当 HTML 标签吞掉** | `x<0` 存进去变成空或乱码 | 写编辑器前强制 HTML 转义 |
| **同一门课有多个班级（clazzid）** | 做错班级，白做一遍 | `courses` 命令把每个 clazzid 单独列出来 |
| **登录 cookie 是 session cookie** | 关浏览器就掉登录 | 导出到 `auth.json`，启动时注入 |
| **直接 goto 作业列表被判"长时间没有操作"** | 拿到空白页 | 先走课程页再点"作业"tab |
| **重做弹窗不是 `#popok`** | 点不动 | 新版 `.wouter` 里的"重做"按钮，旧版才用 `#popok` |
| **重做次数有限，用完 `[重做]` 链接消失** | 想重做没机会 | `list` 命令显示 `canRedo`，`redo` 前先检查 |

## 安装

```bash
git clone https://github.com/<you>/chaoxing-homework.git
cd chaoxing-homework
npm install          # 只依赖 playwright-core，不下载浏览器
```

需要本机已装 Edge 或 Chrome。找路径的顺序在 `lib/browser.js` 里，也可以用 `CX_BROWSER` 指定。

## 快速开始

```bash
# 1. 登录一次（会弹浏览器，手动登完自动导出 cookie）
node cli.js login

# 2. 看自己有哪些课——注意同名课程的 clazzid 不同
node cli.js courses

# 3. 看某门课的作业列表
node cli.js list --course 123456789 --class 987654321
```

`list` 输出类似：

```
[1] 第1章 C语言程序设计概述  status=done score=100 workId=10000001 canRedo=true
[2] 第2章 顺序结构程序设计    status=done score=100 workId=10000002 canRedo=true
[3] 第3章 选择结构程序设计    status=todo score=-   workId=10000003 canRedo=false
```

## 做题流程

```bash
# 把题目导成模板（同时把题干、选项打到终端，方便你/AI 作答）
node cli.js dump --course <id> --class <id> --chapter 3

# 编辑 answers/ch3.json，填上答案
# 先只填不交，检查回读是否全部一致
node cli.js fill --course <id> --class <id> --chapter 3

# 填 + 保存 + 提交
node cli.js submit --course <id> --class <id> --chapter 3

# 看成绩和逐空对错
node cli.js score --course <id> --class <id> --chapter 3
```

`answers/ch3.json` 格式（键是题号，从 1 开始）：

```json
{
  "1": { "choice": "面向机器语言" },
  "11": { "blanks": ["53"] },
  "16": { "blanks": ["缩进", "无影响", "/**/", "//"] }
}
```

选择题的 `choice` 写**选项原文**（可以只写唯一能匹配到的片段），不要写字母。

### 只想重做某一章

```bash
node cli.js redo --course <id> --class <id> --chapter 3
```

会消耗一次重做机会。弹窗里写的"以最高成绩为最终成绩"是真的，重做不会把已有高分拉低。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CX_PORT` | `9223` | 远程调试端口 |
| `CX_PROFILE` | `./.edge-profile` | 浏览器用户目录 |
| `CX_AUTH` | `./auth.json` | 登录态文件 |
| `CX_BROWSER` | 自动探测 | 浏览器可执行文件路径 |
| `CX_COURSE` / `CX_CLASS` | — | 省掉每次传 `--course` / `--class` |

## 命令一览

| 命令 | 作用 |
|---|---|
| `login` | 打开浏览器登录并导出 cookie |
| `courses` | 列出所有课程与 clazzid |
| `list` | 列出某门课的作业及状态/分数 |
| `dump` | 导出题目模板 + 打印题干选项 |
| `fill` | 只填答案，回读校验，不保存 |
| `submit` | 填 + 回读校验 + 保存 + 提交 |
| `score` | 读成绩页，逐空标 ✓/✗ |
| `redo` | 重做某一章 |

## 设计要点（改代码前先看）

**所有 `page.evaluate` 的函数必须自包含。** `page.evaluate(fn)` 只序列化函数体，模块作用域里的变量（比如 `norm`）不会带过去，会直接 `ReferenceError`。所以 `lib/dom.js` 里每个函数都自己定义一遍 `norm`。

**提交用 `saveWork()` 而不是点按钮。** `saveWork()` 内部会对每题调 `syncAnswer()`，把 UEditor 内容刷进 hidden input 再 serialize 整个表单 POST 到 `addStudentWorkNewWeb`。所以顺序必须是「先 setContent → 再 saveWork」，反了存的就是旧值。

**提交后页面显示"未完成"是正常的**，文案不准。真实成绩去成绩页看。

**判断题空里别重复题干关键词。** 题干写"……称为 ______ 运算符"，空里填"成员"就对了，填"成员运算符"判错——判分是按空逐字比对的。

## 答案正确性

工具不保证答案对。C 语言这类题**用编译器实际跑**，别手推：

```bash
gcc q.c -o q.exe && ./q.exe
```

数组/字符串/指针题手推极易错（`\0` 截断、`sizeof` vs `strlen`、下标越界）。图片题（题干是 `<img>`）要先下载再读：

```js
const r = await ctx.request.get(url);   // 用浏览器 context 的 request，带 cookie
fs.writeFileSync('q.png', await r.body());
```

`curl` 会拿到防盗链 HTML，`page.evaluate(fetch)` 会 `Failed to fetch`。小图（<200px）放大 8–10 倍再交给视觉模型，否则 `%ld` 会被读成 `%old`。

## 免责声明

仅供学习自动化技术、减少重复点击。请遵守你所在学校的学术规范——**别用它代做你本该自己做的作业**。作者不对使用后果负责。

## License

MIT
