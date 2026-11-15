// 一键把课程内容导出成 PDF。
//
// 用法：
//   node scripts/export-pdf.mjs            # 默认导出前 4 讲（01–04），合成一本
//   node scripts/export-pdf.mjs 1 2 3 4    # 指定某几讲，合成一本
//   node scripts/export-pdf.mjs 1,2,3,4    # 也可用逗号
//   node scripts/export-pdf.mjs all        # 按「篇」分组，每篇一册（封面 + 篇目录 + 各讲）
//   node scripts/export-pdf.mjs book       # 全书合订成一本（封面 + 总目录 + 每篇扉页 + 各讲，含页码）
//   node scripts/export-pdf.mjs book --no-build   # 跳过 astro build，直接用现有 dist
//
// 原理：先用 astro build 得到静态 HTML，再用无头 Chrome（系统已装 Google Chrome）
// 渲染每一讲，注入 @media print 样式去站点导航、让正文按 A4 分页；每篇再拼上
// 程序生成的封面页与「篇目录」页，最后用 pdf-lib 合成 PDF 并加页码。
import { chromium } from 'playwright';
import { PDFDocument, rgb } from 'pdf-lib';
import http from 'node:http';
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'exports');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'course-pdf-'));
const PORT = 4329;

const CONTENT_MARGIN = { top: '16mm', right: '15mm', bottom: '18mm', left: '15mm' };
const COVER_MARGIN = { top: 0, right: 0, bottom: 0, left: 0 };
const TOC_MARGIN = { top: '18mm', right: '18mm', bottom: '20mm', left: '18mm' };

const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四'];
const FONTS_LINK = '<link rel="preconnect" href="https://fonts.googleapis.com" />' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />' +
  '<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&family=Noto+Sans+SC:wght@400;500&display=swap" rel="stylesheet" />';

const pad2 = (n) => String(n).padStart(2, '0');

/* ---------- 打印样式（正文页） ---------- */
const PRINT_CSS = `
html, body { width: auto !important; height: auto !important; background: #fff !important; overflow: visible !important; }
html.ai-full, html.ai-full body { height: auto !important; overflow: visible !important; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.ai-app { height: auto !important; min-height: 0 !important; display: block !important; grid-template-rows: none !important; }
.ai-top, .ai-searchbtn, .ai-menu, .ai-seg, .ai-kbd, .ai-pal-bg, .ai-foot, .ai-side,
.ai-side-home, .ai-sidenav, .ai-stepnav, .ai-cmp, .ai-compare, .cmp, .ai-toc { display: none !important; }
.ai-scroll { overflow: visible !important; height: auto !important; min-height: 0 !important; display: block !important; }
.ai-shell { display: block !important; max-width: none !important; padding: 0 !important; margin: 0 !important; grid-template-columns: none !important; }
.ai-shell-main { min-width: 0 !important; display: block !important; }
.ai-doc { max-width: none !important; padding: 0 !important; margin: 0 !important; }
.ai-read { min-height: 0 !important; height: auto !important; display: block !important; }
.ai-article { font-size: 16px !important; line-height: 28px !important; color: #1a1a1a !important; }
.ai-article h1 { font-size: 28px !important; line-height: 36px !important; break-after: avoid; }
.ai-article h2 { font-size: 21px !important; line-height: 30px !important; break-after: avoid; }
.ai-article h3 { break-after: avoid; }
.ai-art-head { break-after: avoid; }
.ai-article p, .ai-article li, .ai-article dd, .ai-article .ai-lead { orphans: 3; widows: 3; }
.ai-article pre, .ai-article .astro-code, .katex-display, .ai-article img,
.ai-article figure, .ai-article table, .ai-art-formula, .ai-art-shape { break-inside: avoid; }
.ai-article pre.astro-code { overflow-x: visible !important; white-space: pre-wrap !important; word-break: break-word; }
.ai-article code { word-break: break-word; }
figure, .ai-fig { break-inside: avoid; }
`;

/* ---------- 全书合订：封面 / 篇扉页 / 总目录 ---------- */
function buildBookCoverHtml(count, range, chStats) {
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  // 视频号照片：base64 内嵌，确保任何机器渲染都能显示
  let videoImg = '';
  try {
    const p = path.join(ROOT, 'public', '视频号.JPG');
    videoImg = 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');
  } catch (e) { videoImg = ''; }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AI Infra-HandBook · 全书</title>${FONTS_LINK}<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: #f9f8f5; }
.cover { min-height: 100vh; display: flex; flex-direction: column; align-items: center;
  padding: 28mm 26mm 22mm; color: #1d1d1b; font-family: "Noto Serif SC", "Songti SC", serif; }
.brand { font-family: "Noto Sans SC", sans-serif; font-size: 11px; letter-spacing: .4em; color: #1f6b5a; }
.mid { margin-top: 22mm; text-align: center; }
.rule { width: 54px; height: 3px; background: #1f6b5a; margin: 0 auto 22px; }
.kicker { font-family: "Noto Sans SC", sans-serif; font-size: 13px; letter-spacing: .22em; color: #5c5b55; }
h1.title { font-size: 58px; line-height: 1.14; font-weight: 700; color: #1d1d1b; margin: 12px 0 10px; letter-spacing: .02em; }
.sub { font-family: "Noto Sans SC", sans-serif; font-size: 15px; color: #706e66; margin-top: 12px; letter-spacing: .08em; }
.author { margin-top: 30mm; text-align: center; font-family: "Noto Sans SC", sans-serif; }
.author .row { display: flex; align-items: baseline; justify-content: center; gap: 14px; margin: 7px 0; }
.author .lab { font-size: 12px; color: #9a978e; letter-spacing: .22em; }
.author .val { font-size: 20px; color: #1d1d1b; letter-spacing: .1em; }
.foot { margin-top: auto; text-align: center; }
.version { font-family: "Noto Sans SC", sans-serif; font-size: 13px; color: #1f6b5a; letter-spacing: .14em; }
.links { margin-top: 10px; font-family: "Noto Sans SC", sans-serif; font-size: 11px; color: #706e66; line-height: 19px; }
.links a { color: #1f6b5a; text-decoration: none; }
.qr { margin-top: 12px; width: 32mm; height: auto; display: block; }
</style></head><body><div class="cover">
  <div class="brand">AI INFRA · HANDBOOK</div>
  <div class="mid">
    <div class="rule"></div>
    <div class="kicker">用大模型逐讲编写的 AI 基础设施交互式课程</div>
    <h1 class="title">《AI Infra-HandBook》</h1>
    <div class="sub">LLM 推理 · 工程实践 · 从原理讲到能跑的引擎</div>
  </div>
  <div class="author">
    <div class="row"><span class="lab">作者</span><span class="val">孙晓辉</span></div>
    <div class="row"><span class="lab">视频号</span><span class="val">扶摇 Sun</span></div>
  </div>
  <div class="foot">
    <div class="version">V1.0 · ${today}</div>
    <div class="links">
      <div>在线学习　<a href="https://ai-infra-handbook.sunxiaohui2022.workers.dev/">https://ai-infra-handbook.sunxiaohui2022.workers.dev/</a></div>
      <div>GitHub　<a href="https://github.com/sunxiaohui2025/AI-Infra-Handbook">https://github.com/sunxiaohui2025/AI-Infra-Handbook</a></div>
    </div>
    ${videoImg ? `<img class="qr" src="${videoImg}" alt="视频号 · 扶摇Sun" />` : ''}
  </div>
</div></body></html>`;
}

function buildPartDividerHtml(part, name, lectures) {
  const cn = CN_NUM[part] || String(part);
  const ids = lectures.map((l) => l.id);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>第 ${cn} 篇 ${name}</title>${FONTS_LINK}<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: #f7f6f2; }
.divider { min-height: 100vh; display: flex; flex-direction: column; justify-content: center;
  padding: 30mm 28mm; color: #1d1d1b; font-family: "Noto Serif SC", "Songti SC", serif; }
.brand { font-family: "Noto Sans SC", sans-serif; font-size: 11px; letter-spacing: .3em; color: #1f6b5a; }
.rule { width: 46px; height: 3px; background: #1f6b5a; margin: 22px 0 26px; }
.kicker { font-family: "Noto Sans SC", sans-serif; font-size: 14px; letter-spacing: .18em; color: #5c5b55; }
h1 { font-size: 46px; font-weight: 700; margin: 8px 0 4px; }
.meta { font-family: "Noto Sans SC", sans-serif; font-size: 14px; color: #706e66; margin-top: 20px; }
</style></head><body><div class="divider">
  <div class="brand">AI INFRA · HANDBOOK</div>
  <div class="rule"></div>
  <div class="kicker">第 ${cn} 篇</div>
  <h1>${name}</h1>
  <div class="meta">收录 ${lectures.length} 讲 · 第 ${ids[0]}–${ids[ids.length - 1]} 讲</div>
</div></body></html>`;
}

function buildMasterTocHtml(pn, parts, pageMap, chStats) {
  const allLectures = parts.flatMap((p) => p.lectures);
  const count = allLectures.length;
  const { chapters, totalParts } = chStats || { chapters: 5, totalParts: 17 };
  const sections = parts.map((p) => {
    const divPg = pageMap.div[p.part] || '';
    const rows = p.lectures.map((l) => {
      const tag = l.level === '选读' ? '选读' : (l.minutes ? `约 ${l.minutes} 分钟` : '');
      return `<li><span class="no">${pad2(l.id)}</span><span class="t">${l.title}</span>` +
        (tag ? `<span class="tag${l.level === '选读' ? ' opt' : ''}">${tag}</span>` : '') +
        `<span class="pg">${pageMap.lec[l.id] || ''}</span></li>`;
    }).join('');
    return `<section><div class="part">第 ${p.part} 篇 · ${p.name}<span class="pg">${divPg}</span></div><ol>${rows}</ol></section>`;
  }).join('');
  const pending = `${parts.length < totalParts ? `<section class="pending"><div class="part">其余篇目</div><div class="nolect">全站共 ${totalParts} 篇，此处只收录已完成的 ${parts.length} 篇（${count} 讲）。</div></section>` : ''}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>目录 · AI Infra-HandBook</title>${FONTS_LINK}<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: #fff; color: #1d1d1b; font-family: "Noto Serif SC", "Songti SC", serif; }
.kicker { font-family: "Noto Sans SC", sans-serif; font-size: 11px; letter-spacing: .3em; color: #1f6b5a; }
h1 { font-size: 30px; font-weight: 700; margin: 12px 0 6px; }
.sub { font-family: "Noto Sans SC", sans-serif; font-size: 13px; color: #706e66; margin-bottom: 24px; }
section { margin-bottom: 22px; break-inside: avoid; }
.part { display: flex; justify-content: space-between; align-items: baseline;
  font-size: 18px; font-weight: 700; padding: 8px 0; border-bottom: 2px solid #1f6b5a; margin-bottom: 4px; }
.part .pg { font-family: "JetBrains Mono", "SF Mono", monospace; font-size: 12px; font-weight: 400; color: #1f6b5a; }
ol { list-style: none; }
li { display: flex; align-items: baseline; gap: 10px; padding: 7px 0; border-bottom: 1px solid #f0eee8; }
li .no { font-family: "JetBrains Mono", "SF Mono", monospace; font-size: 12px; color: #1f6b5a; min-width: 24px; }
li .t { font-size: 15px; }
li .tag { font-family: "Noto Sans SC", sans-serif; font-size: 11px; color: #706e66; margin-left: auto; white-space: nowrap; }
li .tag.opt { color: #b45b1e; }
li .pg { font-family: "JetBrains Mono", "SF Mono", monospace; font-size: 12px; color: #706e66; min-width: 28px; text-align: right; }
.pending .nolect { font-family: "Noto Sans SC", sans-serif; font-size: 13px; color: #9a978e; padding: 8px 0 2px; }
</style></head><body><div class="toc">
  <div class="kicker">AI INFRA · HANDBOOK</div>
  <h1>目 录</h1>
  <div class="sub">全书 ${chapters} 章 ${totalParts} 篇 · 本整理版收录 ${count} 讲（已写 ${parts.length} 篇）</div>
  ${sections}
  ${pending}
</div></body></html>`;
}

/* ---------- 封面 / 篇目录 的 HTML ---------- */
function buildCoverHtml(part, name, count, range) {
  const cn = CN_NUM[part] || String(part);
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>第 ${cn} 篇 ${name}</title>${FONTS_LINK}<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: #f7f6f2; }
.cover { min-height: 100vh; display: flex; flex-direction: column; justify-content: space-between;
  padding: 34mm 26mm 28mm; color: #1d1d1b; font-family: "Noto Serif SC", "Songti SC", serif; }
.brand { font-family: "Noto Sans SC", sans-serif; font-size: 11px; letter-spacing: .35em; color: #1f6b5a; text-transform: uppercase; }
.mid { }
.rule { width: 46px; height: 3px; background: #1f6b5a; margin: 22px 0 26px; }
.part-kicker { font-family: "Noto Sans SC", sans-serif; font-size: 14px; letter-spacing: .18em; color: #5c5b55; }
h1.part-name { font-size: 52px; line-height: 1.15; font-weight: 700; color: #1d1d1b; margin: 10px 0 4px; }
.lecture-range { font-size: 15px; color: #706e66; margin-top: 18px; }
.foot { font-family: "Noto Sans SC", sans-serif; font-size: 12px; color: #706e66; line-height: 24px; }
</style></head><body><div class="cover">
  <div class="brand">AI INFRA · HANDBOOK</div>
  <div class="mid">
    <div class="rule"></div>
    <div class="part-kicker">分篇书册 · 第 ${cn} 篇</div>
    <h1 class="part-name">${name}</h1>
    <div class="lecture-range">第 ${range[0]}–${range[1]} 讲 · 收录 ${count} 讲</div>
  </div>
  <div class="foot">节选自《AI Infra-HandBook》<br>导出于 ${today}</div>
</div></body></html>`;
}

function buildTocHtml(part, name, lectures) {
  const rows = lectures.map((l) => {
    const tag = l.level === '选读' ? '<span class="tag opt">选读</span>'
      : l.minutes ? `<span class="tag">约 ${l.minutes} 分钟</span>` : '';
    return `<li><span class="no">${pad2(l.id)}</span><span class="t">${l.title}</span>${tag}</li>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>第 ${part} 篇 ${name} · 目录</title>${FONTS_LINK}<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: #fff; color: #1d1d1b; font-family: "Noto Serif SC", "Songti SC", serif; }
.toc { }
.kicker { font-family: "Noto Sans SC", sans-serif; font-size: 11px; letter-spacing: .3em; color: #1f6b5a; }
h1 { font-size: 28px; font-weight: 700; margin: 12px 0 6px; }
.sub { font-family: "Noto Sans SC", sans-serif; font-size: 13px; color: #706e66; margin-bottom: 26px; }
ol { list-style: none; }
li { display: flex; align-items: baseline; gap: 12px; padding: 11px 0; border-bottom: 1px solid #eceae4; }
li .no { font-family: "JetBrains Mono", "SF Mono", monospace; font-size: 13px; color: #1f6b5a; min-width: 26px; }
li .t { font-size: 16px; }
li .tag { font-family: "Noto Sans SC", sans-serif; font-size: 11px; color: #706e66; margin-left: auto; white-space: nowrap; }
li .tag.opt { color: #b45b1e; border: 1px solid #e7c9b0; border-radius: 999px; padding: 1px 8px; }
</style></head><body><div class="toc">
  <div class="kicker">第 ${part} 篇</div>
  <h1>${name}</h1>
  <div class="sub">本册目录 · 共 ${lectures.length} 讲</div>
  <ol>${rows}</ol>
</div></body></html>`;
}

/* ---------- 工具 ---------- */
function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const ml = line.match(/^(\w+):\s*(.*)$/);
    if (ml) {
      let v = ml[2].trim();
      v = v.replace(/^['"]|['"]$/g, '');
      fm[ml[1]] = v;
    }
  }
  return fm;
}

function readPN() {
  const src = readFileSync(path.join(ROOT, 'src', 'data', 'course.ts'), 'utf-8');
  const m = src.match(/PN: Record<number, string> = \{([^}]*)\};/);
  const pn = {};
  if (m) {
    const re = /(\d+):\s*'([^']*)'/g;
    let mm;
    while ((mm = re.exec(m[1]))) pn[+mm[1]] = mm[2];
  }
  return pn;
}

function readCH() {
  // 解析 CH 数组里的 chapter 条目，取章数与总篇数（用来在封面/目录写“几章几篇”）。
  const src = readFileSync(path.join(ROOT, 'src', 'data', 'course.ts'), 'utf-8');
  const m = src.match(/export const CH: Chapter\[\] = \[([\s\S]*?)\];/);
  let totalParts = 0;
  if (m) {
    const re = /n:\s*(\d+),/g;
    let mm;
    let chapters = 0;
    while ((mm = re.exec(m[1]))) { chapters = Math.max(chapters, +mm[1]); }
    const partsRe = /parts:\s*\[([^\]]*)\]/g;
    let pm;
    while ((pm = partsRe.exec(m[1]))) totalParts += pm[1].split(',').filter(Boolean).length;
    return { chapters: chapters || 5, totalParts: totalParts || 14 };
  }
  return { chapters: 5, totalParts: 14 };
}

function collectLectures() {
  const lectDir = path.join(ROOT, 'src', 'content', 'lectures');
  const out = [];
  for (const f of fs.readdirSync(lectDir).filter((x) => x.endsWith('.mdx'))) {
    const fm = parseFrontmatter(readFileSync(path.join(lectDir, f), 'utf-8'));
    if (!fm.id) continue;
    out.push({ id: +fm.id, part: +fm.part || 0, title: fm.title || '', level: fm.level || '主线', minutes: fm.minutes });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

function groupByPart(lectures, pn) {
  const by = new Map();
  for (const l of lectures) {
    if (!by.has(l.part)) by.set(l.part, []);
    by.get(l.part).push(l);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0])
    .map(([part, list]) => ({ part, name: pn[part] || `第 ${part} 篇`, lectures: list }));
}

/* ---------- 渲染 ---------- */
async function renderHtmlToPdf(browser, html, margin) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  await page.setContent(html, { waitUntil: 'networkidle' });
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) {}
  await page.waitForTimeout(200);
  const buf = await page.pdf({ format: 'A4', printBackground: true, margin });
  await page.close();
  return buf;
}

/* 带并发上限的 map：同时最多跑 limit 个任务，避免一讲等一讲拖慢整本书。 */
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = [];
  const n = Math.min(limit, items.length);
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

async function renderBook(browser, parts, pn, chStats) {
  const allLectures = parts.flatMap((p) => p.lectures);
  const range = [allLectures[0].id, allLectures[allLectures.length - 1].id];
  const cover = await renderHtmlToPdf(browser, buildBookCoverHtml(allLectures.length, range, chStats), COVER_MARGIN);

  // 并发渲染篇扉页 + 各讲，避免串行等待拖慢整本书
  const CONC = 4;
  const dividers = await mapConcurrent(parts, CONC, async (p) =>
    renderHtmlToPdf(browser, buildPartDividerHtml(p.part, p.name, p.lectures), COVER_MARGIN));
  const flatIds = allLectures.map((l) => l.id);
  const lecBufs = await mapConcurrent(flatIds, CONC, async (id) => {
    const buf = await renderLecturePdf(browser, id);
    process.stdout.write(`    渲染第 ${pad2(id)} 讲…\r`);
    return buf;
  });
  // 按篇重新分组
  const partData = parts.map((p, i) => ({ divider: dividers[i], lecBufs: p.lectures.map((l) => lecBufs[flatIds.indexOf(l.id)]) }));

  // 先渲一次目录（无页码）量页数
  const dummyToc = buildMasterTocHtml(pn, parts, { div: {}, lec: {} }, chStats);
  const dummyBuf = await renderHtmlToPdf(browser, dummyToc, TOC_MARGIN);
  const tocPages = (await PDFDocument.load(dummyBuf)).getPageCount();

  // 布局：封面(index 0) + 目录(tocPages) + [扉页 + 各讲]
  const pageMap = { div: {}, lec: {} };
  let next = 1 + tocPages;
  for (let i = 0; i < parts.length; i++) {
    pageMap.div[parts[i].part] = next; next += 1;
    for (let j = 0; j < parts[i].lectures.length; j++) {
      pageMap.lec[parts[i].lectures[j].id] = next;
      next += (await PDFDocument.load(partData[i].lecBufs[j])).getPageCount();
    }
  }
  const totalPages = next;

  // 带页码重渲目录，再合并
  const tocBuf = await renderHtmlToPdf(browser, buildMasterTocHtml(pn, parts, pageMap, chStats), TOC_MARGIN);
  const realPages = (await PDFDocument.load(tocBuf)).getPageCount();
  if (realPages !== tocPages) console.warn(`提示：目录页数 ${tocPages} -> ${realPages}，页码可能偏移（建议复查）`);
  const bufs = [cover, tocBuf];
  for (const pd of partData) bufs.push(pd.divider, ...pd.lecBufs);
  const merged = await mergePdfs(bufs, 1);
  return { merged, totalPages, count: allLectures.length, range, tocPages };
}

async function renderLecturePdf(browser, id) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  // 用 'load' 而不是 'networkidle'：有的页面会持续请求资源（如字体/埋点），
  // networkidle 会永远等不到 500ms 零网络静默而超时。'load' 到达即返回，
  // 再等字体就绪 + 固定延时即可稳定输出。
  await page.goto(`http://localhost:${PORT}/l/${id}`, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => { document.documentElement.dataset.route = 'full'; });
  await page.addStyleTag({ content: PRINT_CSS });
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) {}
  await page.waitForTimeout(500);
  const buf = await page.pdf({ format: 'A4', printBackground: true, margin: CONTENT_MARGIN });
  await page.close();
  return buf;
}

/* ---------- 合成 ---------- */
async function mergePdfs(bufs, firstNumberedIndex) {
  const merged = await PDFDocument.create();
  const helv = await merged.embedFont('Helvetica');
  for (const buf of bufs) {
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }
  const all = merged.getPages();
  const M = all.length - firstNumberedIndex;
  all.forEach((p, i) => {
    if (i < firstNumberedIndex) return;
    const { width } = p.getSize();
    const label = `${pad2(i - firstNumberedIndex + 1)} / ${M}`;
    p.drawText(label, {
      x: (width - helv.widthOfTextAtSize(label, 8)) / 2,
      y: 14, size: 8, font: helv, color: rgb(0.55, 0.55, 0.55),
    });
  });
  return await merged.save();
}

/* ---------- 静态服务器 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};
function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    let fp = path.join(DIST, p);
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
    if (!fs.existsSync(fp)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

/* ---------- 主流程 ---------- */
async function main() {
  const FLAGS = new Set(['--no-build', '--build']);
  const NO_BUILD = process.argv.includes('--no-build');
  const rawArgs = process.argv.slice(2).filter((a) => !FLAGS.has(a)).flatMap((a) => a.split(',')).filter(Boolean);
  let mode;
  if (rawArgs.length === 0) { mode = 'book'; }
  else if (rawArgs.length === 1 && ['all', '*', '全部'].includes(rawArgs[0].toLowerCase())) { mode = 'all'; }
  else if (rawArgs.length === 1 && ['book', '全书', '单册'].includes(rawArgs[0].toLowerCase())) { mode = 'book'; }
  else { mode = 'list'; }

  if (!NO_BUILD) {
    const needBuild = !fs.existsSync(path.join(DIST, 'index.html'));
    console.log(needBuild ? '未找到 dist，执行 astro build…' : '刷新 dist，以确保 PDF 与当前讲义一致…');
    execSync('npx astro build', { cwd: ROOT, stdio: 'inherit' });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pn = readPN();
  const chStats = readCH();
  const allLectures = collectLectures();
  const writtenIds = allLectures.map((l) => l.id);
  const byId = new Map(allLectures.map((l) => [l.id, l]));

  if (writtenIds.length === 0) { console.error('没有找到任何已写的讲。'); process.exit(1); }

  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  try {
    if (mode === 'book') {
      const parts = groupByPart(allLectures, pn);
      const { merged, totalPages, count, range } = await renderBook(browser, parts, pn, chStats);
      const fname = 'AI-Infra-HandBook-全书.pdf';
      fs.writeFileSync(path.join(OUT_DIR, fname), merged);
      console.log(`\n✅ 已导出全书：${path.join(OUT_DIR, fname)}（${count} 讲 · 第 ${range[0]}–${range[1]} 讲 · 共 ${totalPages} 页）`);
    } else if (mode === 'all') {
      const parts = groupByPart(allLectures, pn);
      let done = 0, skipped = 0;
      for (const p of parts) {
        if (p.lectures.length === 0) { skipped++; continue; }
        const ids = p.lectures.map((l) => l.id);
        const cover = await renderHtmlToPdf(browser, buildCoverHtml(p.part, p.name, ids.length, [ids[0], ids[ids.length - 1]]), COVER_MARGIN);
        const toc = await renderHtmlToPdf(browser, buildTocHtml(p.part, p.name, p.lectures), TOC_MARGIN);
        const lecBufs = await mapConcurrent(ids, 4, async (id) => {
          const buf = await renderLecturePdf(browser, id);
          process.stdout.write(`    渲染第 ${pad2(id)} 讲…\r`);
          return buf;
        });
        const merged = await mergePdfs([cover, toc, ...lecBufs], 1);
        const fname = `第${p.part}篇-${p.name}.pdf`;
        fs.writeFileSync(path.join(OUT_DIR, fname), merged);
        done++;
        console.log(`  ✓ 第 ${p.part} 篇《${p.name}》 → ${fname}（${p.lectures.length} 讲）`);
      }
      console.log(`\n✅ 完成：${done} 篇书册导出到 ${OUT_DIR}（跳过 ${skipped} 个无内容的篇）`);
    } else {
      let chosen;
      if (mode === 'sample') chosen = [1, 2, 3, 4].filter((n) => byId.has(n));
      else {
        const req = rawArgs.map((x) => parseInt(x, 10));
        chosen = req.filter((n) => byId.has(n));
        const missing = req.filter((n) => !byId.has(n));
        if (missing.length) console.log('（跳过未写的讲：' + missing.join(', ') + '）');
      }
      if (chosen.length === 0) { console.log('这些讲还没写。'); process.exit(1); }
      const bufs = await mapConcurrent(chosen, 4, async (id) => {
        const buf = await renderLecturePdf(browser, id);
        process.stdout.write(`    渲染第 ${pad2(id)} 讲…\r`);
        return buf;
      });
      const merged = await mergePdfs(bufs, 0);
      const name = chosen.length === 1 ? `第${pad2(chosen[0])}讲.pdf`
        : `AI-Infra-课程-${pad2(chosen[0])}至${pad2(chosen[chosen.length - 1])}讲.pdf`;
      fs.writeFileSync(path.join(OUT_DIR, name), merged);
      console.log(`\n✅ 已导出：${path.join(OUT_DIR, name)}（${chosen.length} 讲，共 ${(await PDFDocument.load(merged)).getPageCount()} 页）`);
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
