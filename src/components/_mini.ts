// 第五章组件共用：从课程目录下的 miniinfer/ 读取代码和运行输出（构建时读取，页面里的代码永远和仓库一致）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeToHtml } from 'shiki';

// 第五章组件共用：读取 miniinfer/ 里的代码和运行输出（构建时读取，页面里的代码永远和仓库一致）。
// CI 只克隆这个仓库，而 miniinfer/ 在仓库外，所以这里读的是镜像到仓库内的 site/miniinfer/。
// 本地开发时若 miniinfer/ 里的代码或 outputs/ 有更新，把对应文件同步到 ./miniinfer/ 即可。
const __here = path.dirname(fileURLToPath(import.meta.url));
export const MINI = path.resolve(__here, '..', '..', 'miniinfer');
export const readMini = (rel: string) => fs.readFileSync(path.join(MINI, rel), 'utf8').replace(/\s+$/, '');

/** 用 Shiki 高亮，每一行的 <span class="line"> 带上 data-line（从 first 开始编号）。 */
export async function highlight(code: string, first = 1, lang = 'python') {
  return codeToHtml(code, {
    lang, theme: 'github-light',
    transformers: [{ line(node, line) { node.properties['data-line'] = line + first - 1; } }],
  });
}

/** 取文件的第 a–b 行（含两端，从 1 开始）。 */
export function sliceLines(text: string, a?: number, b?: number) {
  const ls = text.split('\n');
  return ls.slice((a ?? 1) - 1, b ?? ls.length).join('\n');
}

/** 按行做最长公共子序列，得到 [' '|'+'|'-', 行] 的差异列表。文件都很短，O(nm) 足够。 */
export function lineDiff(a: string, b: string) {
  const x = a.split('\n'), y = b.split('\n'), n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: [string, string, number, number][] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push([' ', x[i], i + 1, j + 1]); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { out.push(['+', y[j], 0, j + 1]); j++; }
    else { out.push(['-', x[i], i + 1, 0]); i++; }
  }
  return out;
}
