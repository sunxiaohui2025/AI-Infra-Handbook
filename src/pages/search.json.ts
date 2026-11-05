// ⌘K 搜索索引：篇、讲，以及已写文章里实际出现的二级标题（小节）。
import { getCollection, render } from 'astro:content';
import { CH, PN, LECTURES, pad, chName, lecture } from '../data/course';

export async function GET() {
  const idx: object[] = [];
  CH.forEach((c) =>
    c.parts.forEach((p) =>
      idx.push({ k: '篇', href: `/p/${p}`, num: String(p), t: `第 ${p} 篇 ${PN[p]}`, sub: chName(c), hay: (PN[p] + chName(c)).toLowerCase() }),
    ),
  );
  LECTURES.forEach((l) =>
    idx.push({ k: '讲', href: `/l/${l.id}`, num: pad(l.id), t: l.title, sub: l.q, hay: `${pad(l.id)} ${l.title}${l.q}${l.demo}`.toLowerCase() }),
  );
  for (const entry of await getCollection('lectures')) {
    const l = lecture(entry.data.id);
    const { headings } = await render(entry);
    headings.filter((h) => h.depth === 2).forEach((h) =>
      idx.push({
        k: '小节', href: `/l/${l.id}#${h.slug}`, num: pad(l.id), t: `${l.title} › ${h.text}`,
        sub: `第 ${l.part} 篇 ${PN[l.part]}`, hay: `${pad(l.id)} ${l.title} ${h.text}`.toLowerCase(), sec: h.text.toLowerCase(),
      }),
    );
  }
  return new Response(JSON.stringify(idx), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
