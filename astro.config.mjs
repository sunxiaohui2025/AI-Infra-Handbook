import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import remarkCjkFriendly from 'remark-cjk-friendly';

export default defineConfig({
  integrations: [mdx()],
  server: { port: 4321 },
  markdown: {
    // 让 **加粗** 紧挨中文标点时也能生效
    remarkPlugins: [remarkCjkFriendly],
    shikiConfig: { theme: 'github-light' },
  },
  vite: {
    // 文章从课程目录下的 tinylm/tinylm.json 读取数字（在 site/ 之外）
    server: { fs: { allow: ['..'] } },
  },
});
