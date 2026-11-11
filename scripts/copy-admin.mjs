// 构建后把运营后台 SPA（admin/public）拷进 dist/admin，
// 使静态站点发布后 /admin/ 页面也能被当成静态资源访问。
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'admin', 'public');
const dest = join(root, 'dist', 'admin');

if (!existsSync(src)) {
  console.log('[copy-admin] 跳过：未找到 admin/public');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('[copy-admin] admin/public -> dist/admin');
