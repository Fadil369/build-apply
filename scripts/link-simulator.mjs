// Link the live Browser Run simulator into every BUILD curriculum day page
// (and the parent "Secret Sauce" page) on Notion.
import fs from 'node:fs';

const NOTION_TOKEN = readEnv('NOTION_TOKEN');
const PARENT = '3bd3479c-6f62-815e-b77e-d5203f23bfaa';
const SIM_BASE = 'https://simulator.brainsait.org';

function readEnv(name) {
  const line = fs.readFileSync('/home/fadil369/.hermes/.env', 'utf8')
    .split('\n').find((l) => l.startsWith(name + '='));
  return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : '';
}

async function notion(path, opts = {}) {
  const r = await fetch('https://api.notion.com/v1' + path, {
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    ...opts,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}

function simCallout(day) {
  return { object: 'block', type: 'callout', callout: {
    icon: { type: 'emoji', emoji: '🖥️' },
    rich_text: [
      { type: 'text', text: { content: `شاهد النظام الحقيقي الآن — المحاكي الحي (لقطة حقيقية من ${day ? 'اليوم ' + day : 'المنظومة'})`, link: { url: day != null ? `${SIM_BASE}/day/${day}` : SIM_BASE } } },
    ],
  }};
}

async function main() {
  // 1. Parent page callout linking the whole simulator.
  await notion(`/blocks/${PARENT}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children: [
      { object: 'block', type: 'callout', callout: {
        icon: { type: 'emoji', emoji: '🧠' },
        rich_text: [
          { type: 'text', text: { content: 'المحاكي الحي — شاهد كل نظام تعمل أمامك بلقطات حقيقية مولّدة عبر Cloudflare Browser Run', link: { url: SIM_BASE } } },
        ],
      }},
    ]}),
  });

  // 2. Append a simulator link to each day page.
  const kids = await notion(`/blocks/${PARENT}/children?page_size=100`);
  let linked = 0;
  for (const b of kids.results) {
    if (b.type !== 'child_page') continue;
    const title = b.child_page?.title || '';
    const m = title.match(/اليوم (\d+)/);
    const day = m ? parseInt(m[1], 10) : null;
    await notion(`/blocks/${b.id}/children`, {
      method: 'PATCH',
      body: JSON.stringify({ children: [simCallout(day)] }),
    });
    linked++;
    console.log(`  linked ${b.id} (${title})`);
  }
  console.log('DONE — linked', linked, 'day pages + parent');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
