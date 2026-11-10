import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export default defineConfig({
  integrations: [mdx()],
  server: { port: 4321 },
  markdown: {
    // 让 **加粗** 紧挨中文标点时也能生效
    // remarkMath 只启用 $$…$$ 块级公式，禁用单个 $ 行内公式，避免与“$0.018”这类美元金额冲突
    remarkPlugins: [remarkCjkFriendly, [remarkMath, { singleDollarTextMath: false }]],
    rehypePlugins: [rehypeKatex],
    shikiConfig: { theme: 'github-light' },
  },
  vite: {
    // 文章从课程目录下的 tinylm/tinylm.json 读取数字（在 site/ 之外）
    server: {
      fs: { allow: ['..'] },
      // dev 时把 /api/* 代理到本地的运营后台，埋点/反馈就能真正存进去（生产静态站靠 PUBLIC_BACKEND_BASE）
      proxy: { '/api': 'http://localhost:8787' },
    },
  },
});
