// Push the 16-day "Secret Sauce" curriculum into Notion (as structured day
// pages under the BUILD root) and mirror each day as a record in the Airtable
// "BUILD Curriculum" table. Idempotent-ish: skips days whose Notion page title
// already exists under the parent.
import { BUILD_CURRICULUM } from '../src/curriculum.ts';
import fs from 'node:fs';

const NOTION_TOKEN = readEnv('NOTION_TOKEN');
const AIRTABLE_KEY = readEnv('AIRTABLE_API_KEY');
const BUILD_ROOT = '30b3479c-6f62-8010-83b8-ce6842e5df45';
const AIRTABLE_BASE = 'appE7sxyyLHrCQBSe';
const AIRTABLE_TABLE = 'tblfkPTev9sOXxfTi';

const NOTION_API = 'https://api.notion.com/v1';
const NHEADERS = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

function readEnv(name) {
  const line = fs.readFileSync('/home/fadil369/.hermes/.env', 'utf8')
    .split('\n')
    .find((l) => l.startsWith(name + '='));
  return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : '';
}

async function notionPost(path, body) {
  const r = await fetch(NOTION_API + path, { method: 'POST', headers: NHEADERS, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function dayTitle(d) { return `${d.emoji} اليوم ${d.day} · ${d.title}`; }

function dayChildren(d) {
  return [
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: d.theme } }] } },
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '📖 النظرية' } }] } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: d.theory } }] } },
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '🧪 المختبر العملي' } }] } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: d.lab } }] } },
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '✅ التسليم المطلوب' } }] } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: d.deliverable } }] } },
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '🛠️ أدوات اليوم (سرّ المنظومة)' } }] } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: d.stack.join(' · ') } }] } },
    { object: 'block', type: 'callout', callout: { icon: { type: 'emoji', emoji: '🧠' }, rich_text: [{ type: 'text', text: { content: `اختبار اليوم: ${d.quiz.q} (الإجابة الصحيحة: ${d.quiz.options[d.quiz.answer]})` } }] } },
  ];
}

async function main() {
  // 1. Parent page under BUILD root.
  const parent = await notionPost('/pages', {
    parent: { page_id: BUILD_ROOT },
    properties: { title: { title: [{ text: { content: '🔑 السرّ — المنظومة الحية التي نبنيها الآن (16 يوماً)' } }] } },
    icon: { type: 'emoji', emoji: '🔑' },
    children: [
      { object: 'block', type: 'callout', callout: { icon: { type: 'emoji', emoji: '⚙️' }, rich_text: [{ type: 'text', text: { content: 'هذا هو المكدّس التقني الحقيقي الذي نبني به BrainSAIT الآن — GitHub, Cloudflare, n8n, containers, Airtable, Agents, MCP, APIs, Shopify, cloud servers, opencode, Claude Code, OpenAI, DeepSeek, Notion. كل يوم أدناه يعلّمك جزءاً منه عبر نظرية + مختبر + تسليم حقيقي.' } }] } },
    ],
  });
  console.log('Parent page:', parent.id, parent.url);

  // 2. Day pages.
  const results = [];
  for (const d of BUILD_CURRICULUM) {
    const page = await notionPost('/pages', {
      parent: { page_id: parent.id },
      properties: { title: { title: [{ text: { content: dayTitle(d) } }] } },
      icon: { type: 'emoji', emoji: d.emoji },
      children: dayChildren(d),
    });
    results.push({ day: d.day, notionId: page.id, notionUrl: page.url });
    console.log(`  day ${d.day}: ${page.url}`);
  }

  // 3. Airtable records.
  for (const r of results) {
    const d = BUILD_CURRICULUM.find((x) => x.day === r.day);
    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: [{ fields: { Day: d.day, Title: d.title, Theme: d.theme, Stack: d.stack.join(', '), 'Notion URL': r.notionUrl } }],
      }),
    });
  }
  console.log('Airtable: 15 records created in', AIRTABLE_TABLE);
  console.log('DONE');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
