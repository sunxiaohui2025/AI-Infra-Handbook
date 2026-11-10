import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// 每讲一个 MDX 文件，头部元数据与大纲「每讲的统一模板」一致。
// 没有文件的讲，文章页按模板显示占位。
const lectures = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/lectures' }),
  schema: z.object({
    id: z.number(),
    slug: z.string(),
    title: z.string(),
    chapter: z.number(),
    part: z.number(),
    problem: z.string(),
    prereqs: z.array(z.number()).default([]),
    level: z.enum(['主线', '选读']).default('主线'),
    minutes: z.number().optional(),
    demos: z.array(z.string()).default([]),
    video: z.string().default(''),
    formula: z.string().optional(),
  }),
});

export const collections = { lectures };
