export interface Env {
  EVIDENCE_BUCKET: R2Bucket;
  APPLICATIONS: KVNamespace;
  NOTION_TOKEN: string;
  NOTION_BUILD_DB_ID: string;
  NOTION_COHORTS_DB_ID?: string;
  NOTION_SPRINTS_DB_ID?: string;
  NOTION_MILESTONES_DB_ID?: string;
  NOTION_TASKS_DB_ID?: string;
  TURNSTILE_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_ADMIN_TOKEN?: string;
  SHOPIFY_WEBHOOK_SECRET?: string;
  ADMIN_TOKEN?: string;
  HUB_URL?: string;
  HUB_KEY?: string;
}

interface KvTask {
  name: string;
  status: 'To Do' | 'Done';
  channel: string;
}

interface KvApplication {
  ref: string;
  fullName: string;
  email: string;
  phone?: string;
  country?: string;
  identity: string;
  profession?: string;
  category?: string;
  organizationName?: string;
  universityName?: string;
  website?: string;
  buildingDescription?: string;
  tier: string;
  trackName: string;
  trackUrl: string;
  finalPrice: number;
  discount: number;
  paymentStatus: string;
  applicationStatus: string;
  notionUrl?: string;
  evidenceKey?: string;
  telegramId?: string;
  createdAt: string;
  tasks: KvTask[];
}

interface EligibilityInput {
  identity?: string; // SA, SD, OTHER
  profession?: string; // doctor, nurse, healthcare, other
  category?: string; // entrepreneur, student, researcher, other
}

interface ApplyPayload {
  lang?: 'ar' | 'en';
  fullName: string;
  email: string;
  phone?: string;
  country?: string;
  identity: string;
  profession?: string;
  category?: string;
  organizationName?: string;
  universityName?: string;
  website?: string;
  linkedinUrl?: string;
  buildingDescription?: string;
  promoCode?: string;
  turnstileToken?: string;
  evidenceFile?: { name: string; type: string; base64: string } | null;
}

interface PricingTier {
  id: string;
  titleEn: string;
  titleAr: string;
  discount: number;
  price: number;
  icon: string;
}

interface PricingResult {
  tier: PricingTier;
  eligibilityId: string;
  discount: number;
  originalPrice: number;
  finalPrice: number;
  savings: number;
  promoCode?: string;
}

const BASE_PRICE = 9630; // SAR — launch offer (limited time)
const ORIGINAL_PRICE = 14960; // SAR — standard price before launch offer

// Second Brain gift + companion links used in the premium paid email.
const SECOND_BRAIN_URL = 'https://fadil369.notion.site/Ultimate-Brain-3bc3479c6f628177afd7fb7e9224c19c';
const FORGE_BOT_URL = 'https://t.me/BrainSAITForgeBot';
const ACCOUNT_URL = 'https://account.brainsait.org';
const BUILD_TRACK_URL = 'https://fadil369.github.io/track';
const BUILD_CERT_BASE = 'https://build-apply.brainsait.org';

// Launch promo codes — validated server-side. The storefront previews the
// same codes via pricingEngine.ts; Shopify checkout applies the code.
const PROMO_CODES: Record<string, { discountPercent: number }> = {
  LAUNCH10: { discountPercent: 10 },
  FOUNDER15: { discountPercent: 15 },
};

function lookupPromo(code?: string): { discountPercent: number } | undefined {
  if (!code) return undefined;
  const normalized = code.trim().toUpperCase();
  return PROMO_CODES[normalized];
}

const ALLOWED_ORIGINS = [
  'https://brainsait.org',
  'https://www.brainsait.org',
  'https://store.brainsait.org',
  'https://build-apply.brainsait.org',
  'https://hub.brainsait.org',
  'https://brainsait.de',
  'https://fadil369.github.io',
  'http://localhost:5173',
  'http://localhost:3000',
];

const TIERS: Record<string, PricingTier> = {
  sa_sd_free: {
    id: 'sa_sd_free',
    titleEn: 'Founding Identity Benefit',
    titleAr: 'استحقاق الهوية التأسيسية',
    discount: 100,
    price: 0,
    icon: '🇸🇦🇸🇩',
  },
  healthcare_50: {
    id: 'healthcare_50',
    titleEn: 'Healthcare Builder Benefit',
    titleAr: 'استحقاق بناة الرعاية الصحية',
    discount: 50,
    price: 4815,
    icon: '🩺',
  },
  warrior_35: {
    id: 'warrior_35',
    titleEn: 'Warrior Entrepreneur Benefit',
    titleAr: 'استحقاق رائد الأعمال المحارب',
    discount: 35,
    price: 6259.5,
    icon: '⚔️',
  },
  academic_30: {
    id: 'academic_30',
    titleEn: 'Knowledge Builder Benefit',
    titleAr: 'استحقاق بناة المعرفة',
    discount: 30,
    price: 6741,
    icon: '🎓',
  },
  standard: {
    id: 'standard',
    titleEn: 'Standard Build Ticket',
    titleAr: 'تذكرة البناء العادية',
    discount: 0,
    price: BASE_PRICE,
    icon: '📋',
  },
};

// FLAT launch pricing: all applicants are charged the single 9,630 SAR
// standard variant of the storefront BUILD ticket product.
const SHOPIFY_VARIANTS: Record<string, string> = {
  standard: '45947217870931',
};

const FOUNDER_OS_TRACKS: Record<string, { name: string; url: string }> = {
  sa_sd_free: { name: 'Saudi Founder Track', url: 'https://app.notion.com/p/3ba3479c6f62816aa985dd525c4b0beb' },
  healthcare_50: { name: 'Healthcare Builders', url: 'https://app.notion.com/p/3ba3479c6f62812aafb8e61f1e0eea75' },
  warrior_35: { name: 'Warrior Entrepreneurs', url: 'https://app.notion.com/p/3ba3479c6f62812aafb8e61f1e0eea75' },
  academic_30: { name: 'Research & Academic', url: 'https://app.notion.com/p/3ba3479c6f6281f9b3c7c2b59e4306dc' },
  standard: { name: 'Founder Accelerator', url: 'https://app.notion.com/p/3ba3479c6f62812aafb8e61f1e0eea75' },
};

const SMART_MATCHER_URL = 'https://app.notion.com/p/3ba3479c6f6281d1b7b3f1c1bd1895da';

/**
 * Cloudflare Pages demo hosts that are unreachable from some client networks
 * (Tailscale magicDNS fails to resolve `.pages.dev` for applications). We proxy
 * them through this custom domain so demos open reliably everywhere.
 */
const DEMO_UPSTREAMS: Record<string, string> = {
  'neural-cloud-portal': 'neural-cloud.pages.dev',
  'brainsait-neural-cloud': 'brainsait-neural-cloud.pages.dev',
  'healthcare-directory': 'brainsait-healthcare-directory.pages.dev',
  'doctor-hub': 'brainsait-doctor-hub.pages.dev',
  'travel-code-secure-vault': 'travel-code-secure-vault.pages.dev',
  'healthcare-directory-v2': 'brainsait-healthcare-c6e.pages.dev',
  'browser-ui': 'browser-ui-f4s.pages.dev',
  'clinics-directory': 'clinics-pages.pages.dev',
  'un-innovation-toolkit': 'brainsait-innovation.pages.dev',
  'sbs': 'sbs-elfadil.pages.dev',
  'gtm-playbook': 'brainsait-gtm-arabic.pages.dev',
  'veinforge': 'veinforge-novel.pages.dev',
  'boneforge': 'boneforge-novel.pages.dev',
  'traumaforge': 'traumaforge-novel.pages.dev',
  'shadowforge': 'shadowforge-novel.pages.dev',
  'cellforge': 'cellforge-novel.pages.dev',
  'melissa-hospitality': 'melissa-hotel.pages.dev',
  'museum-hilton': 'museum-hilton.pages.dev',
  'bsa-rcp-academy': 'brainsait-academy-live.pages.dev',
  'nphies-drg-kb': 'nphies-drg-kb.pages.dev',
  'hetzner-guide': 'hetzner-guide-ehn.pages.dev',
  'iris-academy': 'iris-academy.pages.dev',
  'coding-ksa-academy': 'coding-ksa-academy.pages.dev',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_EVIDENCE_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function jsonResponse(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

interface EligibilityData {
  fullName?: string;
  email?: string;
  identity?: string;
  country?: string;
  profession?: string;
  promoCode?: string;
}

function calculatePrice(data: EligibilityData, promoCode?: string): PricingResult {
  // Launch pricing is FLAT: every BUILD seat is SAR 9,630 (was SAR 14,960).
  // Identity and profession are still collected (stored in Notion) for cohort
  // routing and CRM, but no longer change the price. A valid promo code adds
  // a discount on top of the launch price.
  const tier = TIERS.standard;
  const promo = lookupPromo(promoCode);
  const promoDiscount = promo ? promo.discountPercent : 0;
  const finalPrice = promo ? BASE_PRICE * (1 - promoDiscount / 100) : BASE_PRICE;
  const savings = ORIGINAL_PRICE - finalPrice;
  const normalized = promoCode?.trim().toUpperCase();

  return {
    tier,
    eligibilityId: tier.id,
    discount: promoDiscount,
    originalPrice: ORIGINAL_PRICE,
    finalPrice,
    savings,
    promoCode: promo && normalized ? normalized : undefined,
  };
}

async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token }),
  });
  const data = (await resp.json()) as { success?: boolean };
  return data.success === true;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function decodeBase64File(file: { base64: string }): Uint8Array {
  const raw = file.base64.includes(',') ? file.base64.split(',')[1] : file.base64;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function contentTypeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return map[ext || ''] || 'application/octet-stream';
}

function identityLabel(v?: string): string {
  if (v === 'SA') return 'SA';
  if (v === 'SD') return 'SD';
  return 'Other';
}

function professionLabel(v?: string): string {
  if (v === 'doctor') return 'Doctor';
  if (v === 'nurse') return 'Nurse';
  if (v === 'healthcare') return 'Healthcare Other';
  if (v === 'other') return 'Other';
  return '';
}

function categoryLabel(v?: string): string {
  if (v === 'entrepreneur') return 'Warrior Entrepreneur';
  if (v === 'student') return 'Student';
  if (v === 'researcher') return 'Researcher';
  if (v === 'other') return 'Other';
  return '';
}

function tierLabel(v: string): string {
  const map: Record<string, string> = {
    sa_sd_free: 'SA_SD_FREE',
    healthcare_50: 'HEALTHCARE_50',
    warrior_35: 'WARRIOR_35',
    academic_30: 'ACADEMIC_30',
    standard: 'STANDARD',
  };
  return map[v] || v.toUpperCase();
}

async function createNotionPage(
  env: Env,
  payload: ApplyPayload,
  pricing: PricingResult,
  appRef: string,
  track: { name: string; url: string },
  evidenceUrl?: string,
): Promise<{ id: string; url: string }> {
  const identity = identityLabel(payload.identity);
  const profession = professionLabel(payload.profession);
  const category = categoryLabel(payload.category);

  const props: Record<string, any> = {
    Name: { title: [{ text: { content: payload.fullName || 'Unknown' } }] },
    Email: { email: payload.email || '' },
    Country: payload.country ? { select: { name: payload.country } } : undefined,
    Identity: identity ? { select: { name: identity } } : undefined,
    Profession: profession ? { select: { name: profession } } : undefined,
    Category: category ? { select: { name: category } } : undefined,
    Organization: payload.organizationName
      ? { rich_text: [{ text: { content: payload.organizationName } }] }
      : undefined,
    University: payload.universityName
      ? { rich_text: [{ text: { content: payload.universityName } }] }
      : undefined,
    Website: payload.website ? { url: payload.website } : undefined,
    LinkedIn: payload.linkedinUrl ? { url: payload.linkedinUrl } : undefined,
    'Eligibility Tier': { select: { name: tierLabel(pricing.eligibilityId) } },
    'Base Price': { number: pricing.originalPrice },
    'Discount %': { number: pricing.discount / 100 },
    'Discount Amount': { number: pricing.savings },
    'Final Price': { number: pricing.finalPrice },
    'Verification Status': { select: { name: 'Pending' } },
    'Payment Status': { select: { name: pricing.finalPrice === 0 ? 'Waived' : 'Pending' } },
    'Payment Reference': { rich_text: [{ text: { content: appRef } }] },
    'Application Status': { select: { name: 'New' } },
    'Founder OS Track': { select: { name: track.name } },
    'Founder OS Track URL': { url: track.url },
    'Evidence URL': evidenceUrl ? { url: evidenceUrl } : undefined,
    'Submitted At': { date: { start: new Date().toISOString() } },
    Notes: { rich_text: [{ text: { content: buildNotes(payload, appRef, track, evidenceUrl) } }] },
  };

  const cleanProps: Record<string, any> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined) cleanProps[k] = v;
  }

  const resp = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ parent: { database_id: env.NOTION_BUILD_DB_ID }, properties: cleanProps }),
  });

  const result = (await resp.json()) as { id?: string; url?: string; object?: string };
  if (!resp.ok || !result.id) {
    throw new Error(`Notion error: ${JSON.stringify(result)}`);
  }
  return { id: result.id, url: result.url || `https://notion.so/${result.id.replace(/-/g, '')}` };
}

function buildNotes(payload: ApplyPayload, appRef: string, track: { name: string; url: string }, evidenceUrl?: string): string {
  const parts = [
    `Application ref: ${appRef}`,
    `Recommended Founder OS track: ${track.name} — ${track.url}`,
    payload.buildingDescription ? `Description: ${payload.buildingDescription}` : '',
    payload.phone ? `Phone: ${payload.phone}` : '',
    evidenceUrl ? `Evidence: ${evidenceUrl}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

async function sendConfirmationEmail(
  env: Env,
  payload: ApplyPayload,
  pricing: PricingResult,
  appRef: string,
  notionUrl: string,
  track: { name: string; url: string },
  checkoutUrl?: string,
): Promise<void> {
  if (!env.RESEND_API_KEY || !payload.email) return;

  const ar = payload.lang === 'ar';
  const tierTitle = ar ? pricing.tier.titleAr : pricing.tier.titleEn;
  const priceText = pricing.finalPrice === 0
    ? (ar ? 'مجاني' : 'FREE')
    : `${pricing.finalPrice.toLocaleString(ar ? 'ar-SA' : 'en-SA')} SAR`;
  const promoLine = pricing.promoCode
    ? ar
      ? `<li><strong>رمز الخصم المطبق:</strong> ${pricing.promoCode} — خصم ${pricing.discount}%</li>`
      : `<li><strong>Promo applied:</strong> ${pricing.promoCode} — ${pricing.discount}% off</li>`
    : '';
  const originalLine = ar
    ? `<li><strong>السعر الأصلي:</strong> ${ORIGINAL_PRICE.toLocaleString('ar-SA')} SAR — عرض الإطلاق لفترة محدودة</li>`
    : `<li><strong>Original price:</strong> ${ORIGINAL_PRICE.toLocaleString('en-SA')} SAR — limited-time launch offer</li>`;

  const subject = ar
    ? 'تم استلام طلبك في برنامج احتضان BrainSAIT'
    : 'Your BrainSAIT Incubation Application Was Received';

  const html = ar
    ? `<div dir="rtl" style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;line-height:1.6;">
        <h2 style="color:#131320;">مرحباً ${escapeHtml(payload.fullName)} 👋</h2>
        <p>استلمنا طلبك بنجاح. إليك ملخص الاستحقاق:</p>
        <ul>
          <li><strong>فئة الاستحقاق:</strong> ${escapeHtml(tierTitle)}</li>
          ${originalLine}
          <li><strong>السعر النهائي:</strong> ${priceText}</li>
          ${promoLine}
          <li><strong>رقم الطلب:</strong> ${appRef}</li>
        </ul>
        <p style="margin:1rem 0;"><a href="${SMART_MATCHER_URL}">اكتشف مسارك الأمثل عبر Smart Program Matcher →</a></p>
        ${checkoutUrl ? `<p style="margin:1.5rem 0;"><a href="${checkoutUrl}" style="background:#e9c46a;color:#131320;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:700;">إتمام الدفع</a></p>` : '<p>ستتواصل معك الإدارة قريباً لتفعيل وصولك المجاني.</p>'}
        <p style="color:#666;font-size:0.9rem;">يمكنك متابعة حالة طلبك في Notion: <a href="${notionUrl}">${notionUrl}</a></p>
      </div>`
    : `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;line-height:1.6;">
        <h2 style="color:#131320;">Hi ${escapeHtml(payload.fullName)} 👋</h2>
        <p>We received your application successfully. Here's your eligibility summary:</p>
        <ul>
          <li><strong>Benefit tier:</strong> ${escapeHtml(tierTitle)}</li>
          ${originalLine}
          <li><strong>Final price:</strong> ${priceText}</li>
          ${promoLine}
          <li><strong>Application ref:</strong> ${appRef}</li>
        </ul>
        <p style="margin:1rem 0;"><a href="${SMART_MATCHER_URL}">Find your best path with the Smart Program Matcher →</a></p>
        ${checkoutUrl ? `<p style="margin:1.5rem 0;"><a href="${checkoutUrl}" style="background:#e9c46a;color:#131320;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:700;">Complete payment</a></p>` : '<p>Our team will reach out shortly to activate your free access.</p>'}
        <p style="color:#666;font-size:0.9rem;">Track your application in Notion: <a href="${notionUrl}">${notionUrl}</a></p>
      </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'BrainSAIT <orders@brainsait.org>',
      to: payload.email,
      subject,
      html,
    }),
  });
}

function escapeHtml(text?: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function validateEmail(email?: string): boolean {
  return !!email && EMAIL_RE.test(email);
}

function addDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

async function notionRequest(env: Env, method: string, path: string, body?: any): Promise<any> {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await resp.json()) as any;
  if (!resp.ok) {
    throw new Error(`Notion ${method} ${path} error: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createTask(
  env: Env,
  task: {
    name: string;
    candidateId: string;
    dueDays?: number;
    channel?: 'Notion' | 'Email' | 'Telegram';
    automated?: boolean;
    assigneeEmail?: string;
  },
): Promise<void> {
  if (!env.NOTION_TASKS_DB_ID) return;
  const props: Record<string, any> = {
    Name: { title: [{ text: { content: task.name } }] },
    Candidate: { relation: [{ id: task.candidateId }] },
    Status: { select: { name: 'To Do' } },
    Channel: { select: { name: task.channel || 'Notion' } },
    Automated: { checkbox: task.automated ?? false },
  };
  if (task.dueDays !== undefined) {
    props['Due Date'] = { date: { start: addDays(task.dueDays) } };
  }
  if (task.assigneeEmail) {
    props['Assignee Email'] = { email: task.assigneeEmail };
  }
  await notionRequest(env, 'POST', '/pages', { parent: { database_id: env.NOTION_TASKS_DB_ID }, properties: props });
}

async function createInitialTasks(env: Env, candidateId: string): Promise<void> {
  if (!env.NOTION_TASKS_DB_ID) return;
  await createTask(env, { name: 'Verify applicant evidence', candidateId, dueDays: 1, channel: 'Notion' });
  await createTask(env, { name: 'Approve or reject application', candidateId, dueDays: 2, channel: 'Notion' });
  await createTask(env, { name: 'Send welcome email once approved', candidateId, dueDays: 2, channel: 'Email', automated: true });
}

// The 14-day BUILD curriculum — one milestone per day plus the final capstone.
// Seeded automatically when an application is approved & paid, so the
// automated certification system has a real target to track.
const MILESTONE_TEMPLATE: { name: string; automation: 'Auto' | 'Manual'; day: number }[] = [
  { name: '🔥 اليوم 0 · الإشعال — اختيار الفكرة', automation: 'Manual', day: 0 },
  { name: '🎯 اليوم 1 · التحديد — العميل ونموذج العمل', automation: 'Manual', day: 1 },
  { name: '🏗️ اليوم 2 · البناء — الهوية والعلامة والمحتوى', automation: 'Manual', day: 2 },
  { name: '🔌 اليوم 3 · التكامل — المتجر والدفع والتسليم الآلي', automation: 'Manual', day: 3 },
  { name: '🧪 اليوم 4 · التحقق — أول عملاء حقيقيين', automation: 'Manual', day: 4 },
  { name: '🚀 اليوم 5 · الإطلاق — النشر الأول والإعلان', automation: 'Manual', day: 5 },
  { name: '📣 اليوم 6 · قنوات السوق والجذب', automation: 'Manual', day: 6 },
  { name: '🤖 اليوم 7 · أتمتة كل شيء', automation: 'Manual', day: 7 },
  { name: '👥 اليوم 8 · العملاء والتسليم', automation: 'Manual', day: 8 },
  { name: '📊 اليوم 9 · التحليلات والقرارات', automation: 'Manual', day: 9 },
  { name: '📈 اليوم 10 · التوسع والتسعير', automation: 'Manual', day: 10 },
  { name: '🧠 اليوم 11 · الذكاء الاصطناعي في شركتك', automation: 'Manual', day: 11 },
  { name: '🛡️ اليوم 12 · الأمن والامتثال', automation: 'Manual', day: 12 },
  { name: '👑 اليوم 13 · العلامة الشخصية وقيادة الفكر', automation: 'Manual', day: 13 },
  { name: '🏆 اليوم 14 · التخرج والعرض', automation: 'Manual', day: 14 },
  { name: '🏗️ المشروع الختامي — المنظومة المتكاملة', automation: 'Auto', day: 15 },
];

async function milestoneExists(env: Env, candidateId: string, name: string): Promise<boolean> {
  try {
    const data = await notionRequest(env, 'POST', `/databases/${env.NOTION_MILESTONES_DB_ID}/query`, {
      filter: { and: [
        { property: 'Candidate', relation: { contains: candidateId } },
        { property: 'Name', title: { equals: name } },
      ] },
    });
    return (data.results || []).length > 0;
  } catch { return true; /* fail-safe: don't duplicate blindly */ }
}

/** Seed the full 16-milestone curriculum for a candidate (idempotent). */
async function seedMilestones(env: Env, candidateId: string): Promise<void> {
  if (!env.NOTION_MILESTONES_DB_ID) return;
  for (const m of MILESTONE_TEMPLATE) {
    if (await milestoneExists(env, candidateId, m.name)) continue;
    try {
      await notionRequest(env, 'POST', '/pages', {
        parent: { database_id: env.NOTION_MILESTONES_DB_ID },
        properties: {
          Name: { title: [{ text: { content: m.name } }] },
          Candidate: { relation: [{ id: candidateId }] },
          Status: { select: { name: 'Not Started' } },
          Automation: { select: { name: m.automation } },
          'Due Date': { date: { start: addDays(m.day) } },
        },
      });
    } catch { /* best-effort per milestone */ }
  }
}

/** When every task is Done, auto-complete milestones marked Automation=Auto. */
async function autoCompleteAutoMilestones(env: Env, candidateId: string): Promise<void> {
  if (!env.NOTION_TASKS_DB_ID || !env.NOTION_MILESTONES_DB_ID) return;
  const progress = await calculateProgress(env, candidateId);
  if (progress.totalTasks === 0 || progress.doneTasks < progress.totalTasks) return;
  const mData = await notionRequest(env, 'POST', `/databases/${env.NOTION_MILESTONES_DB_ID}/query`, {
    filter: { and: [
      { property: 'Candidate', relation: { contains: candidateId } },
      { property: 'Status', select: { does_not_equal: 'Completed' } },
      { property: 'Automation', select: { equals: 'Auto' } },
    ] },
  });
  for (const r of mData.results || []) {
    try {
      await notionRequest(env, 'PATCH', `/pages/${r.id}`, {
        properties: { 'Status': { select: { name: 'Completed' } } },
      });
    } catch { /* best-effort */ }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * KV application store — used when Notion has not been configured yet, so
 * the Build page works end-to-end (apply → ref → progress) with zero
 * external dependencies. When NOTION_TOKEN + NOTION_BUILD_DB_ID are set the
 * Notion path takes over automatically.
 * ───────────────────────────────────────────────────────────────────────── */
const KV_KEY = (ref: string) => `app:${ref}`;

function notionConfigured(env: Env): boolean {
  return !!env.NOTION_TOKEN && !!env.NOTION_BUILD_DB_ID;
}

function kvInitialTasks(): KvTask[] {
  return [
    { name: 'Verify applicant evidence', status: 'To Do', channel: 'Notion' },
    { name: 'Approve or reject application', status: 'To Do', channel: 'Notion' },
    { name: 'Send welcome email once approved', status: 'To Do', channel: 'Email' },
  ];
}

function kvOnboardingTasks(env: Env): KvTask[] {
  return [
    { name: 'Create cohort & sprint plan', status: 'To Do', channel: 'Notion' },
    { name: 'Invite to Telegram Forge Bot', status: 'To Do', channel: 'Telegram' },
    { name: 'Schedule onboarding call', status: 'To Do', channel: 'Email' },
  ];
}

async function kvGet(env: Env, ref: string): Promise<KvApplication | null> {
  try {
    const raw = await env.APPLICATIONS.get(KV_KEY(ref));
    return raw ? (JSON.parse(raw) as KvApplication) : null;
  } catch {
    return null;
  }
}

async function kvList(env: Env): Promise<KvApplication[]> {
  const out: KvApplication[] = [];
  try {
    let cursor: string | undefined;
    for (;;) {
      const page = await env.APPLICATIONS.list({ prefix: 'app:', cursor });
      for (const item of page.keys) {
        const app = await kvGet(env, item.name.slice(4));
        if (app) out.push(app);
      }
      if (page.list_complete) break;
      cursor = page.cursor;
    }
  } catch { /* ignore */ }
  return out;
}

async function kvPut(env: Env, app: KvApplication): Promise<void> {
  try {
    await env.APPLICATIONS.put(KV_KEY(app.ref), JSON.stringify(app));
  } catch { /* ignore */ }
}

function kvBadges(tasks: KvTask[]): string[] {
  const done = tasks.filter((t) => t.status === 'Done').length;
  const badges: string[] = [];
  if (done >= 1) badges.push('Onboarded');
  if (done >= 3) badges.push('Activated');
  if (done >= 5) badges.push('Builder');
  if (tasks.length > 0 && done === tasks.length) badges.push('Launch Ready');
  if (tasks.some((t) => t.name.toLowerCase().includes('launch') && t.status === 'Done')) badges.push('Launched');
  return badges;
}

function kvProgress(app: KvApplication): ProgressInfo {
  const totalTasks = app.tasks.length;
  const doneTasks = app.tasks.filter((t) => t.status === 'Done').length;
  const percent = totalTasks > 0 ? doneTasks / totalTasks : 0;
  return {
    totalTasks,
    doneTasks,
    percent,
    badges: kvBadges(app.tasks),
    tasks: app.tasks.map((t) => ({ name: t.name, status: t.status, channel: t.channel })),
    milestones: [],
    nextTask: app.tasks.find((t) => t.status !== 'Done')?.name || null,
  };
}

async function emitHubEvent(env: Env, evt: Record<string, unknown>): Promise<void> {
  try {
    const base = env.HUB_URL || 'https://brainsait.de';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.HUB_KEY) headers['X-Hub-Key'] = env.HUB_KEY;
    await fetch(`${base}/api/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify(evt),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* best-effort */ }
}

async function findApplicationByRef(env: Env, appRef: string): Promise<{ id: string; properties: any; kv?: KvApplication; url?: string } | null> {
  if (notionConfigured(env)) {
    try {
      const data = await notionRequest(env, 'POST', `/databases/${env.NOTION_BUILD_DB_ID}/query`, {
        filter: { property: 'Payment Reference', rich_text: { equals: appRef } },
      });
      if (data.results?.[0]) {
        return { id: data.results[0].id, properties: data.results[0].properties, url: data.results[0].url || undefined };
      }
    } catch { /* fall through to KV */ }
  }
  const kv = await kvGet(env, appRef);
  return kv ? { id: KV_KEY(appRef), properties: {}, kv, url: kv.notionUrl } : null;
}

async function createOnboardingPlan(env: Env, candidateId: string, payload: ApplyPayload): Promise<void> {
  if (!(await taskExists(env, candidateId, 'Create cohort & sprint plan'))) {
    await createTask(env, { name: 'Create cohort & sprint plan', candidateId, dueDays: 0, channel: 'Notion' });
  }
  if (!(await taskExists(env, candidateId, 'Invite to Telegram Forge Bot'))) {
    await createTask(env, { name: 'Invite to Telegram Forge Bot', candidateId, dueDays: 0, channel: 'Telegram', automated: true });
  }
  if (!(await taskExists(env, candidateId, 'Schedule onboarding call'))) {
    await createTask(env, { name: 'Schedule onboarding call', candidateId, dueDays: 1, channel: 'Email' });
  }
  if (env.NOTION_MILESTONES_DB_ID) {
    const exists = await relationPageNameExists(env, env.NOTION_MILESTONES_DB_ID, candidateId, 'Cohort enrollment completed');
    if (!exists) {
      await notionRequest(env, 'POST', '/pages', {
        parent: { database_id: env.NOTION_MILESTONES_DB_ID },
        properties: {
          Name: { title: [{ text: { content: 'Cohort enrollment completed' } }] },
          Candidate: { relation: [{ id: candidateId }] },
          Status: { select: { name: 'Completed' } },
          Automation: { select: { name: 'Auto' } },
        },
      });
    }
  }
}

async function relationPageNameExists(env: Env, dbId: string, candidateId: string, name: string): Promise<boolean> {
  const data = await notionRequest(env, 'POST', `/databases/${dbId}/query`, {
    filter: { and: [
      { property: 'Candidate', relation: { contains: candidateId } },
      { property: 'Name', title: { equals: name } },
    ] },
  });
  return (data.results || []).length > 0;
}

async function taskExists(env: Env, candidateId: string, name: string): Promise<boolean> {
  if (!env.NOTION_TASKS_DB_ID) return true; // can't check → assume exists (skip)
  return relationPageNameExists(env, env.NOTION_TASKS_DB_ID, candidateId, name);
}

async function verifyShopifyHmac(body: string, hmac: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return computed === hmac;
}

async function handleShopifyWebhook(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const body = await request.text();
  const hmac = request.headers.get('x-shopify-hmac-sha256') || '';
  const topic = request.headers.get('x-shopify-topic') || '';

  // The webhook secret is mandatory: without it every forged request would be
  // trusted as a genuine "paid" event and applicants could be approved without
  // paying. Fail closed (503 → Shopify retries) until an operator sets
  // SHOPIFY_WEBHOOK_SECRET via `wrangler secret put`.
  if (!env.SHOPIFY_WEBHOOK_SECRET) {
    console.error('SHOPIFY_WEBHOOK_SECRET is not configured — rejecting webhook');
    return jsonResponse({ ok: false, error: 'Webhook secret not configured' }, 503, origin);
  }

  const ok = await verifyShopifyHmac(body, hmac, env.SHOPIFY_WEBHOOK_SECRET);
  if (!ok) {
    return jsonResponse({ ok: false, error: 'Invalid Shopify HMAC' }, 401, origin);
  }

  if (topic && topic !== 'orders/paid') {
    return jsonResponse({ ok: false, error: 'Unexpected Shopify topic' }, 400, origin);
  }

  let order: any;
  try {
    order = JSON.parse(body);
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400, origin);
  }

  // application_ref is attached by the Build flow in the checkout link as a
  // line-item property (`properties[application_ref]` → line_items[].properties).
  // Also accept top-level note_attributes and order.properties for robustness.
  const attrs = order.note_attributes || [];
  const itemProps = (order.line_items || []).flatMap((li: any) => li.properties || []);
  const topProps = order.properties || [];
  const findRef = (list: any[]) => {
    const attr = list.find((a: any) => a.name === 'application_ref' || a.name === 'applicationRef');
    return attr?.value ?? attr?.application_ref ?? null;
  };
  const appRef = findRef(attrs) || findRef(itemProps) || findRef(topProps);

  if (!appRef) {
    // Genuine Shopify order that is not a BUILD ticket (e.g. regular store
    // purchase). Acknowledge so Shopify stops retrying.
    return jsonResponse({ ok: true, ignored: true, reason: 'not a BUILD order' }, 200, origin);
  }

  const candidate = await findApplicationByRef(env, appRef);
  if (!candidate) {
    return jsonResponse({ ok: false, error: 'Application not found' }, 404, origin);
  }

  const appEmail = candidate.kv
    ? (candidate.kv.email || '').toLowerCase()
    : ((candidate.properties.Email?.email || '') as string).toLowerCase();
  const orderEmail = ((order.email || order.contact_email || '') as string).toLowerCase();
  if (appEmail && orderEmail && appEmail !== orderEmail) {
    return jsonResponse({ ok: false, error: 'Order email does not match application' }, 400, origin);
  }

  const currentPayment = candidate.kv
    ? candidate.kv.paymentStatus
    : candidate.properties['Payment Status']?.select?.name;
  const currentStatus = candidate.kv
    ? candidate.kv.applicationStatus
    : candidate.properties['Application Status']?.select?.name;
  // Idempotent: if already Paid+Approved, no-op success.
  if (currentPayment === 'Paid' && currentStatus === 'Approved') {
    return jsonResponse({ ok: true, applicationId: appRef, status: 'already approved', idempotent: true }, 200, origin);
  }

  let payload: ApplyPayload;
  if (candidate.kv) {
    const app = candidate.kv;
    app.paymentStatus = 'Paid';
    app.applicationStatus = 'Approved';
    app.tasks = [...app.tasks, ...kvOnboardingTasks(env).filter(
      (t) => !app.tasks.some((x) => x.name === t.name),
    )];
    await kvPut(env, app);
    payload = {
      fullName: app.fullName || 'Founder',
      email: orderEmail || app.email || '',
      identity: app.identity || 'OTHER',
      country: app.country || '',
      phone: app.phone || '',
    };
  } else {
    await notionRequest(env, 'PATCH', `/pages/${candidate.id}`, {
      properties: {
        'Payment Status': { select: { name: 'Paid' } },
        'Application Status': { select: { name: 'Approved' } },
      },
    });

    payload = {
      fullName: candidate.properties.Name?.title?.[0]?.plain_text || 'Founder',
      email: order.email || appEmail || '',
      identity: candidate.properties.Identity?.select?.name || 'OTHER',
      country: candidate.properties.Country?.select?.name || '',
      phone: candidate.properties.Phone?.select?.name || '',
    };

    await createOnboardingPlan(env, candidate.id, payload);
    // Paid candidates get the full 16-milestone curriculum seeded so the
    // certification system has a real target to track.
    try { await seedMilestones(env, candidate.id); } catch { /* best-effort */ }
    await updateProgressOnApplication(env, candidate.id);
  }

  // Certificate may already be issuable (e.g. milestones seeded earlier).
  try { await checkAndIssueCertificate(env, candidate, appRef); } catch { /* best-effort */ }

  await emitHubEvent(env, {
    type: 'build.paid',
    source: 'build-apply',
    data: { applicationId: appRef, email: payload.email, orderId: String(order.id || '') },
  });

  // Paid applicants are partners — promote the Shopify customer record with
  // partner tags so they appear in the store's customer/partner directory.
  // The invite email goes out here (paid partner) — not at application time.
  try {
    await syncShopifyCustomer(env, {
      email: orderEmail || payload.email,
      fullName: payload.fullName || 'Founder',
      phone: payload.phone || '',
      country: payload.country || '',
      applicationRef: appRef,
      acceptsMarketing: true,
      tags: ['build-partner', 'paid', 'partner-profile'],
    }, true);
  } catch { /* non-fatal */ }

  if (env.RESEND_API_KEY && payload.email) {
    try {
      await sendPaidWelcomeEmail(env, payload.email, payload.fullName || 'Founder', appRef);
    } catch { /* best-effort */ }
  }

  return jsonResponse({ ok: true, applicationId: appRef, status: 'paid & approved' }, 200, origin);
}

async function sendPaidWelcomeEmail(env: Env, email: string, name: string, appRef: string): Promise<void> {
  const body = `
    <p style="margin:0 0 14px;font-size:17px;color:#131320;"><b>🎉 Welcome, ${escapeHtml(name)}</b></p>
    <p style="margin:0 0 16px;">Your payment is confirmed and your seat is <b>approved</b>. You are officially a BrainSAIT partner now — and a very valuable one.</p>
    <p style="margin:0 0 10px;color:#131320;"><b>🎁 Your Second Brain is waiting</b> — the gift we promised to those who use their first brain very well. It is organized, connected, and alive: 15 days, 18 labs, 16 milestones.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:linear-gradient(135deg,#c9a227,#e9c46a);border-radius:999px;padding:14px 34px;">
      <a href="${SECOND_BRAIN_URL}" style="color:#131320;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:15px;">Open your Second Brain 🧠</a>
    </td></tr></table>
    <p style="margin:0 0 10px;color:#131320;"><b>🤖 Your companion agent</b> — @BrainSAITForgeBot follows you from registration to certificate: daily standups, progress scoring, reminders, and your certificate when you complete everything.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:#131320;border-radius:999px;padding:13px 30px;">
      <a href="${FORGE_BOT_URL}" style="color:#e9c46a;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;">Chat with your bot on Telegram →</a>
    </td></tr></table>
    <p style="margin:0 0 10px;color:#131320;"><b>📈 Your builder profile</b> — connected to your Shopify customer account at <a href="${ACCOUNT_URL}" style="color:#8a6d1f;">account.brainsait.org</a>. Track your progress, showcase your proof, ship your product.</p>
    <hr style="border:none;border-top:1px solid #e5ddc4;margin:20px 0;" />
    <p style="margin:0;color:#666;font-size:13px;font-family:Arial,sans-serif;">Application <b>${appRef}</b> · Track progress at <a href="${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}" style="color:#8a6d1f;">${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}</a></p>
  `;
  const html = luxuryEmailShell('Your BrainSAIT partner seat is active 🎉', body);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'BrainSAIT <orders@brainsait.org>',
      to: email,
      subject: '🎉 Your BrainSAIT partner seat is active — Second Brain inside',
      html,
    }),
  });
}

async function handleCron(_event: ScheduledEvent, env: Env): Promise<void> {
  if (!env.NOTION_BUILD_DB_ID || !env.NOTION_TASKS_DB_ID) return;

  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return; // skip weekends

  const today = now.toISOString().split('T')[0];
  const data = await notionRequest(env, 'POST', `/databases/${env.NOTION_BUILD_DB_ID}/query`, {
    filter: { property: 'Application Status', select: { equals: 'Approved' } },
  });

  for (const candidate of data.results || []) {
    const id = candidate.id;
    const props = candidate.properties;
    const email = props.Email?.email;
    const name = props.Name?.title?.[0]?.plain_text || 'Founder';

    // Skip candidates who already graduated — no more standups needed.
    try {
      const p = await calculateProgress(env, id);
      if (p.milestones.length > 0 && p.milestones.every((m) => m.status === 'Completed')) continue;
    } catch { /* best-effort */ }

    // Unified name with the Telegram bot: `Standup — ${today}`.
    const taskName = `Standup — ${today}`;
    if (!(await taskExists(env, id, taskName))) {
      await createTask(env, { name: taskName, candidateId: id, dueDays: 0, channel: 'Notion' });
    }

    // Auto-issue the certificate as soon as all milestones are completed.
    try {
      const appRef = props['Payment Reference']?.rich_text?.[0]?.plain_text;
      if (appRef) {
        await checkAndIssueCertificate(env, { id, properties: props }, appRef);
      }
    } catch { /* best-effort */ }

    if (env.RESEND_API_KEY && email) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.RESEND_FROM_EMAIL || 'BrainSAIT <orders@brainsait.org>',
          to: email,
          subject: 'Your BrainSAIT Build daily standup',
          html: `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;">
            <h2>Good morning ${escapeHtml(name)} 👋</h2>
            <p>Time for your daily standup. Reply to the Telegram bot with <code>/standup</code> or update your task board in Notion.</p>
            <p><a href="https://t.me/BrainSAITForgeBot">Open Forge Bot</a></p>
          </div>`,
        }),
      });
    }
  }
}

interface ProgressInfo {
  totalTasks: number;
  doneTasks: number;
  percent: number;
  badges: string[];
  tasks: { name: string; status: string; channel: string }[];
  milestones: { name: string; status: string }[];
  nextTask: string | null;
}

async function calculateProgress(env: Env, candidateId: string): Promise<ProgressInfo> {
  const tasksData = env.NOTION_TASKS_DB_ID
    ? await notionRequest(env, 'POST', `/databases/${env.NOTION_TASKS_DB_ID}/query`, {
        filter: { property: 'Candidate', relation: { contains: candidateId } },
      })
    : { results: [] };

  const tasks = (tasksData.results || []).map((r: any) => {
    const p = r.properties;
    return {
      name: p.Name?.title?.[0]?.plain_text || 'Untitled',
      status: p.Status?.select?.name || 'To Do',
      channel: p.Channel?.select?.name || 'Notion',
      id: r.id,
    };
  });

  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t: any) => t.status === 'Done').length;
  const percent = totalTasks > 0 ? doneTasks / totalTasks : 0;
  const nextTask = tasks.find((t: any) => t.status !== 'Done')?.name || null;

  const badges: string[] = [];
  if (doneTasks >= 1) badges.push('Onboarded');
  if (doneTasks >= 3) badges.push('Activated');
  if (doneTasks >= 5) badges.push('Builder');
  if (totalTasks > 0 && doneTasks === totalTasks) badges.push('Launch Ready');
  if (tasks.some((t: any) => t.name.toLowerCase().includes('launch') && t.status === 'Done')) badges.push('Launched');

  let milestones: { name: string; status: string }[] = [];
  if (env.NOTION_MILESTONES_DB_ID) {
    const mData = await notionRequest(env, 'POST', `/databases/${env.NOTION_MILESTONES_DB_ID}/query`, {
      filter: { property: 'Candidate', relation: { contains: candidateId } },
    });
    milestones = (mData.results || []).map((r: any) => ({
      name: r.properties.Name?.title?.[0]?.plain_text || 'Milestone',
      status: r.properties.Status?.select?.name || 'Not Started',
    }));
    if (milestones.some((m) => m.status === 'Completed' && m.name.toLowerCase().includes('launch'))) {
      if (!badges.includes('Launched')) badges.push('Launched');
    }
  }

  return { totalTasks, doneTasks, percent, badges, tasks, milestones, nextTask };
}

async function updateProgressOnApplication(env: Env, candidateId: string, props?: any): Promise<ProgressInfo> {
  const progress = await calculateProgress(env, candidateId);
  const patchProps: Record<string, any> = {
    'Progress %': { number: progress.percent },
    'Badges': { multi_select: progress.badges.map((b) => ({ name: b })) },
    'Last Activity': { date: { start: new Date().toISOString() } },
  };
  if (props) Object.assign(patchProps, props);
  await notionRequest(env, 'PATCH', `/pages/${candidateId}`, { properties: patchProps });
  // All tasks done → auto-complete the Automation=Auto milestone (capstone).
  try { await autoCompleteAutoMilestones(env, candidateId); } catch { /* best-effort */ }
  return progress;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Automated certification — creative completion system.
 *
 * Flow: every time progress is computed (frontend track, bot /day, webhook),
 * we check the candidate's Milestones in Notion. When ALL of them are
 * Completed we issue (once, idempotent via KV) a premium HTML certificate
 * served at GET /certificate/:ref, and email the builder a luxury message
 * with the certificate link + Second Brain gift + Forge bot assistant.
 * ───────────────────────────────────────────────────────────────────────── */

const CERT_KEY = (ref: string) => `cert:${ref}`;

function certificateRef(): string {
  return `BS-CERT-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function certificateHtml(name: string, appRef: string, certCode: string, issuedAt: string, trackName: string): string {
  const safeName = escapeHtml(name);
  const safeTrack = escapeHtml(trackName || 'Founder Accelerator');
  const safeRef = escapeHtml(appRef);
  const safeCode = escapeHtml(certCode);
  const date = new Date(issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BrainSAIT — Completion Certificate</title>
<style>
  :root { --gold:#c9a227; --gold-l:#e9c46a; --ink:#131320; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; background: linear-gradient(160deg,#0d0d16 0%,#16162a 55%,#1c1c33 100%); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:2rem; color:#eee; }
  .sheet { max-width:880px; width:100%; background: linear-gradient(145deg,#fdfcf7,#f4efe0); color:#1b1b1b; border-radius:26px; padding:3.4rem 3rem; position:relative; overflow:hidden; border:1px solid rgba(201,162,39,.5); box-shadow:0 30px 80px rgba(0,0,0,.55); }
  .sheet::before { content:''; position:absolute; inset:14px; border:2px solid rgba(201,162,39,.55); border-radius:18px; pointer-events:none; }
  .sheet::after { content:''; position:absolute; top:-70px; right:-70px; width:240px; height:240px; border-radius:50%; background:radial-gradient(circle,rgba(201,162,39,.22),transparent 70%); }
  .crest { text-align:center; font-size:2.6rem; margin-bottom:.4rem; }
  .brand { text-align:center; letter-spacing:.42em; text-transform:uppercase; font-size:.78rem; font-weight:700; color:#8a6d1f; }
  .seal { text-align:center; font-size:1rem; color:#8a6d1f; letter-spacing:.22em; text-transform:uppercase; margin:.3rem 0 1.8rem; }
  h1 { text-align:center; font-size:1.7rem; font-weight:400; color:#5a4a12; font-variant:small-caps; letter-spacing:.08em; margin-bottom:1.6rem; }
  .intro { text-align:center; color:#555; font-size:1rem; margin-bottom:1.2rem; }
  .name { text-align:center; font-size:2.7rem; color:#131320; font-weight:700; margin:.4rem 0 .3rem; font-family:Georgia,serif; }
  .track { text-align:center; color:#777; font-size:1.05rem; margin-bottom:1.4rem; }
  .for { text-align:center; max-width:560px; margin:0 auto 1.8rem; color:#444; line-height:1.8; font-size:.98rem; }
  .meta { display:flex; justify-content:space-between; gap:1rem; border-top:1px solid rgba(201,162,39,.45); padding-top:1.1rem; margin-top:1.2rem; color:#666; font-size:.85rem; }
  .meta b { color:#5a4a12; }
  .stamp { position:absolute; bottom:34px; left:34px; width:110px; height:110px; border-radius:50%; border:3px dashed rgba(201,162,39,.6); display:flex; align-items:center; justify-content:center; text-align:center; font-size:.62rem; line-height:1.5; color:#8a6d1f; font-weight:700; text-transform:uppercase; letter-spacing:.14em; transform:rotate(-12deg); background:rgba(201,162,39,.07); }
  .foot { position:absolute; bottom:34px; right:38px; text-align:right; color:#8a6d1f; font-size:.8rem; }
  .foot b { display:block; font-size:.95rem; color:#5a4a12; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="crest">🧠</div>
    <div class="brand">BrainSAIT</div>
    <div class="seal">Learn · Build · Solutions</div>
    <h1>Certificate of Completion</h1>
    <p class="intro">This certificate is proudly presented to</p>
    <div class="name">${safeName}</div>
    <p class="track">for completing the ${safeTrack} — 15 days · 18 labs · 16 milestones</p>
    <p class="for">You used your first brain very well — and built a second one with us. This document is our proof, and yours: a story believable enough to be sold, built with tools that last.</p>
    <div class="meta">
      <div><b>Certificate №</b><br/>${safeCode}</div>
      <div><b>Application</b><br/>${safeRef}</div>
      <div><b>Issued</b><br/>${date}</div>
    </div>
    <div class="stamp">The<br/>Second<br/>Brain<br/>Verified</div>
    <div class="foot"><b>BrainSAIT</b>Founder &amp; Incubation<br/>brainsait.org</div>
  </div>
</body>
</html>`;
}

function pendingCertificateHtml(name: string, done: number, total: number): string {
  const safeName = escapeHtml(name);
  return `<!DOCTYPE html>
<html lang="en" dir="ltr"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Certificate — in progress</title>
<style>body{font-family:Georgia,serif;background:#0d0d16;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem}
.card{max-width:520px;text-align:center;background:#16162a;border:1px solid rgba(201,162,39,.4);border-radius:22px;padding:2.6rem}
h1{color:#e9c46a;font-size:1.5rem}.bar{height:10px;border-radius:99px;background:#26263d;margin:1.2rem 0;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,#c9a227,#e9c46a);border-radius:99px;width:${Math.round((done / Math.max(total, 1)) * 100)}%}
p{color:#aaa;line-height:1.7}a{color:#e9c46a}</style></head>
<body><div class="card"><h1>🎓 ${safeName}, your certificate is being earned</h1>
<div class="bar"><div class="fill"></div></div>
<p>Complete all ${total} milestones — ${done} done so far. The moment every milestone is <b>Completed</b>, your premium certificate is issued and emailed to you automatically.</p>
<p><a href="${FORGE_BOT_URL}">@BrainSAITForgeBot</a> is watching your progress. Keep shipping.</p></div></body></html>`;
}

async function milestonesForCandidate(env: Env, candidateId: string): Promise<{ name: string; status: string }[]> {
  if (!env.NOTION_MILESTONES_DB_ID) return [];
  try {
    const mData = await notionRequest(env, 'POST', `/databases/${env.NOTION_MILESTONES_DB_ID}/query`, {
      filter: { property: 'Candidate', relation: { contains: candidateId } },
    });
    return (mData.results || []).map((r: any) => ({
      name: r.properties.Name?.title?.[0]?.plain_text || 'Milestone',
      status: r.properties.Status?.select?.name || 'Not Started',
    }));
  } catch {
    return [];
  }
}

async function checkAndIssueCertificate(
  env: Env,
  candidate: { id: string; properties: any; kv?: KvApplication },
  appRef: string,
): Promise<{ ok: boolean; issued?: boolean; url?: string; code?: string; done?: number; total?: number }> {
  const name = candidate.kv
    ? candidate.kv.fullName
    : candidate.properties.Name?.title?.[0]?.plain_text || 'Builder';
  const email = candidate.kv
    ? candidate.kv.email
    : candidate.properties.Email?.email;

  const milestones = await milestonesForCandidate(env, candidate.id);
  const done = milestones.filter((m) => m.status === 'Completed').length;
  const total = milestones.length;

  if (total === 0) return { ok: true, issued: false, done, total };

  const allDone = done === total;

  // Re-issue path is disabled on purpose — a certificate is issued exactly once.
  let record: any = null;
  try { record = await env.APPLICATIONS.get(CERT_KEY(appRef), 'json'); } catch { /* ignore */ }

  if (!allDone) return { ok: true, issued: false, done, total };

  if (record?.issued) {
    return { ok: true, issued: true, url: `${BUILD_CERT_BASE}/certificate/${encodeURIComponent(appRef)}`, code: record.code, done, total };
  }

  const code = certificateRef();
  const issuedAt = new Date().toISOString();
  const trackName = candidate.kv
    ? candidate.kv.trackName
    : candidate.properties['Founder OS Track']?.select?.name || 'Founder Accelerator';

  try {
    // Permanent record — a certificate number must never rotate or re-issue.
    await env.APPLICATIONS.put(CERT_KEY(appRef), JSON.stringify({ issued: true, code, issuedAt, trackName, email }));
  } catch { /* ignore */ }

  // Notify the builder with a luxury email: certificate + Second Brain + bot.
  if (env.RESEND_API_KEY && email) {
    try {
      const certUrl = `${BUILD_CERT_BASE}/certificate/${encodeURIComponent(appRef)}`;
      await sendCertificateEmail(env, email, name, code, certUrl, appRef);
    } catch { /* best-effort */ }
  }

  await emitHubEvent(env, {
    type: 'build.certificate',
    source: 'build-apply',
    data: { applicationId: appRef, email, name, certificateCode: code },
  });

  return { ok: true, issued: true, url: `${BUILD_CERT_BASE}/certificate/${encodeURIComponent(appRef)}`, code, done, total };
}

function luxuryEmailShell(title: string, bodyHtml: string, extraCss = ''): string {
  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#0d0d16;font-family:Georgia,'Times New Roman',serif;color:#222;">
  <div style="max-width:620px;margin:0 auto;padding:28px 16px;">
    <div style="background:linear-gradient(160deg,#131320 0%,#1e1e35 100%);border-radius:24px;padding:36px 32px;border:1px solid rgba(201,162,39,.35);box-shadow:0 24px 60px rgba(0,0,0,.45);">
      <div style="text-align:center;font-size:34px;line-height:1;">🧠</div>
      <div style="text-align:center;letter-spacing:.38em;text-transform:uppercase;font-size:11px;color:#c9a227;margin:10px 0 4px;font-family:Arial,sans-serif;">BrainSAIT</div>
      <div style="text-align:center;letter-spacing:.24em;text-transform:uppercase;font-size:10px;color:#8f8faf;margin-bottom:24px;font-family:Arial,sans-serif;">Learn · Build · Solutions</div>
      <div style="background:#fdfcf7;border-radius:18px;padding:28px 26px;line-height:1.75;font-size:15px;color:#333;">${bodyHtml}</div>
      <div style="text-align:center;color:#8f8faf;font-size:11px;margin-top:22px;font-family:Arial,sans-serif;">${extraCss}</div>
      <div style="text-align:center;color:#6a6a8a;font-size:11px;margin-top:8px;font-family:Arial,sans-serif;">BrainSAIT · store.brainsait.org · account.brainsait.org</div>
    </div>
  </div>
</body></html>`;
}

async function sendCertificateEmail(
  env: Env,
  email: string,
  name: string,
  certCode: string,
  certUrl: string,
  appRef: string,
): Promise<void> {
  const body = `
    <p style="margin:0 0 14px;font-size:17px;color:#131320;"><b>🎓 Congratulations, ${escapeHtml(name)}</b></p>
    <p style="margin:0 0 16px;">You completed every milestone of the BUILD program. Your premium certificate has been issued — automatically, the moment your last milestone went <b>Completed</b>.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px auto;"><tr><td style="background:linear-gradient(135deg,#c9a227,#e9c46a);border-radius:999px;padding:14px 34px;">
      <a href="${certUrl}" style="color:#131320;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:15px;">View your certificate →</a>
    </td></tr></table>
    <p style="margin:0 0 12px;color:#666;font-size:13px;font-family:Arial,sans-serif;">Certificate № <b>${certCode}</b> · Application ${appRef}</p>
    <hr style="border:none;border-top:1px solid #e5ddc4;margin:20px 0;" />
    <p style="margin:0 0 10px;color:#131320;"><b>🎁 Your Second Brain</b> — proof you used your first one very well, and why you are here. Everything you built is organized there, alive and connected.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:#131320;border-radius:999px;padding:13px 30px;">
      <a href="${SECOND_BRAIN_URL}" style="color:#e9c46a;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;">Open your Second Brain 🧠</a>
    </td></tr></table>
    <p style="margin:0 0 10px;color:#131320;"><b>🤖 Your companion agent</b> — @BrainSAITForgeBot follows you from registration to certificate. It already knows your progress.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:#131320;border-radius:999px;padding:13px 30px;">
      <a href="${FORGE_BOT_URL}" style="color:#e9c46a;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;">Chat with your bot on Telegram →</a>
    </td></tr></table>
    <p style="margin:18px 0 0;color:#666;font-size:13px;font-family:Arial,sans-serif;">You are now a BrainSAIT <b>partner</b>. Your builder profile lives at <a href="${ACCOUNT_URL}" style="color:#8a6d1f;">account.brainsait.org</a> — track progress, share your story, sell what you built.</p>
  `;
  const html = luxuryEmailShell(`Your BrainSAIT Completion Certificate — ${certCode}`, body);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || 'BrainSAIT <orders@brainsait.org>',
      to: email,
      subject: `🎓 Your BrainSAIT Completion Certificate — ${certCode}`,
      html,
    }),
  });
}

async function findApplicationByTelegram(env: Env, telegramId: string): Promise<{ id: string; properties: any; kv?: KvApplication; url?: string } | null> {
  if (notionConfigured(env)) {
    try {
      const data = await notionRequest(env, 'POST', `/databases/${env.NOTION_BUILD_DB_ID}/query`, {
        filter: { property: 'Telegram ID', rich_text: { equals: telegramId } },
      });
      if (data.results?.[0]) {
        return { id: data.results[0].id, properties: data.results[0].properties, url: data.results[0].url || undefined };
      }
    } catch { /* fall through */ }
  }
  const all = await kvList(env);
  const kv = all.find((a) => a.telegramId === telegramId);
  return kv ? { id: KV_KEY(kv.ref), properties: {}, kv, url: kv.notionUrl } : null;
}

async function handleProgress(request: Request, env: Env, applicationRef: string): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!applicationRef || applicationRef.length < 8) {
    return jsonResponse({ ok: false, error: 'Invalid application ref' }, 400, origin);
  }
  const candidate = await findApplicationByRef(env, applicationRef);
  if (!candidate) {
    return jsonResponse({ ok: false, error: 'Application not found' }, 404, origin);
  }
  if (candidate.kv) {
    const app = candidate.kv;
    const progress = kvProgress(app);
    return jsonResponse({
      ok: true,
      applicationId: applicationRef,
      name: app.fullName || 'Founder',
      email: app.email,
      tier: tierLabel(app.tier),
      track: app.trackName,
      trackUrl: app.trackUrl,
      paymentStatus: app.paymentStatus,
      applicationStatus: app.applicationStatus,
      notionUrl: app.notionUrl,
      ...progress,
    }, 200, origin);
  }
  const progress = await calculateProgress(env, candidate.id);
  const props = candidate.properties;

  // Automated certification: when every milestone is Completed, the
  // certificate is issued once (idempotent) and the luxury email goes out.
  try {
    await checkAndIssueCertificate(env, candidate, applicationRef);
  } catch { /* best-effort — progress still returns */ }

  return jsonResponse({
    ok: true,
    applicationId: applicationRef,
    name: props.Name?.title?.[0]?.plain_text || 'Founder',
    email: props.Email?.email,
    tier: props['Eligibility Tier']?.select?.name,
    track: props['Founder OS Track']?.select?.name,
    trackUrl: props['Founder OS Track URL']?.url,
    paymentStatus: props['Payment Status']?.select?.name,
    applicationStatus: props['Application Status']?.select?.name,
    notionUrl: candidate.url,
    ...progress,
  }, 200, origin);
}

async function handleCertificate(request: Request, env: Env, applicationRef: string): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!applicationRef || applicationRef.length < 8) {
    return jsonResponse({ ok: false, error: 'Invalid application ref' }, 400, origin);
  }
  const candidate = await findApplicationByRef(env, applicationRef);
  if (!candidate) {
    return jsonResponse({ ok: false, error: 'Application not found' }, 404, origin);
  }

  const name = candidate.kv
    ? candidate.kv.fullName
    : candidate.properties.Name?.title?.[0]?.plain_text || 'Builder';
  const trackName = candidate.kv
    ? candidate.kv.trackName
    : candidate.properties['Founder OS Track']?.select?.name || 'Founder Accelerator';

  const milestones = await milestonesForCandidate(env, candidate.id);
  const done = milestones.filter((m) => m.status === 'Completed').length;
  const total = milestones.length;

  let record: any = null;
  try { record = await env.APPLICATIONS.get(CERT_KEY(applicationRef), 'json'); } catch { /* ignore */ }

  if (record?.issued) {
    const issuedAt = record.issuedAt || new Date().toISOString();
    return new Response(certificateHtml(name, applicationRef, record.code, issuedAt, trackName), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(origin), 'Cache-Control': 'public, max-age=300' },
    });
  }

  if (total === 0 || done < total) {
    return new Response(pendingCertificateHtml(name, done, total), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(origin), 'Cache-Control': 'no-store' },
    });
  }

  // All milestones complete → issue right now.
  await checkAndIssueCertificate(env, candidate, applicationRef);
  try { record = await env.APPLICATIONS.get(CERT_KEY(applicationRef), 'json'); } catch { /* ignore */ }
  const issuedAt = record?.issuedAt || new Date().toISOString();
  return new Response(certificateHtml(name, applicationRef, record?.code || certificateRef(), issuedAt, trackName), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(origin), 'Cache-Control': 'public, max-age=300' },
  });
}

async function handleBotLink(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const body = (await request.json()) as { application_ref?: string; telegram_id?: string };
  if (!body.application_ref || !body.telegram_id) {
    return jsonResponse({ ok: false, error: 'Missing application_ref or telegram_id' }, 400, origin);
  }
  const candidate = await findApplicationByRef(env, body.application_ref);
  if (!candidate) {
    return jsonResponse({ ok: false, error: 'Application not found' }, 404, origin);
  }
  if (candidate.kv) {
    candidate.kv.telegramId = body.telegram_id;
    await kvPut(env, candidate.kv);
  } else {
    await notionRequest(env, 'PATCH', `/pages/${candidate.id}`, {
      properties: { 'Telegram ID': { rich_text: [{ text: { content: body.telegram_id } }] } },
    });
  }
  return jsonResponse({ ok: true, message: 'Telegram linked to application' }, 200, origin);
}

async function completeNextTask(env: Env, candidateId: string, keyword?: string): Promise<string | null> {
  if (!env.NOTION_TASKS_DB_ID) return null;
  const data = await notionRequest(env, 'POST', `/databases/${env.NOTION_TASKS_DB_ID}/query`, {
    filter: { and: [
      { property: 'Candidate', relation: { contains: candidateId } },
      { property: 'Status', select: { does_not_equal: 'Done' } },
    ] },
  });
  const results = data.results || [];
  let target = results[0];
  if (keyword) {
    target = results.find((r: any) => r.properties.Name?.title?.[0]?.plain_text?.toLowerCase().includes(keyword)) || target;
  }
  if (!target) return null;
  await notionRequest(env, 'PATCH', `/pages/${target.id}`, {
    properties: { 'Status': { select: { name: 'Done' } } },
  });
  return target.properties.Name?.title?.[0]?.plain_text || 'Task';
}

async function handleBotDay(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const body = (await request.json()) as { telegram_id?: string };
  if (!body.telegram_id) {
    return jsonResponse({ ok: false, error: 'Missing telegram_id' }, 400, origin);
  }
  const candidate = await findApplicationByTelegram(env, body.telegram_id);
  if (!candidate) {
    return jsonResponse({ ok: false, error: 'No application linked to this Telegram account. Use /link <application_ref> first.' }, 404, origin);
  }
  let completedTask: string | null;
  let progress: ProgressInfo;
  if (candidate.kv) {
    const app = candidate.kv;
    const open = app.tasks.find((t) => t.status !== 'Done');
    completedTask = open?.name || null;
    if (open) {
      open.status = 'Done';
      await kvPut(env, app);
    }
    progress = kvProgress(app);
  } else {
    completedTask = await completeNextTask(env, candidate.id);
    progress = await updateProgressOnApplication(env, candidate.id);
    // All tasks done → capstone auto-completed → certificate may now be issuable.
    try {
      const appRef = candidate.properties?.['Payment Reference']?.rich_text?.[0]?.plain_text;
      if (appRef) await checkAndIssueCertificate(env, candidate, appRef);
    } catch { /* best-effort */ }
  }
  return jsonResponse({
    ok: true,
    completedTask,
    percent: Math.round(progress.percent * 100),
    doneTasks: progress.doneTasks,
    totalTasks: progress.totalTasks,
    badges: progress.badges,
    message: completedTask
      ? `✅ Completed: ${completedTask}\n📊 Progress: ${Math.round(progress.percent * 100)}% (${progress.doneTasks}/${progress.totalTasks})\n🏆 Badges: ${progress.badges.join(', ') || 'none yet'}`
      : `🎉 All tasks done! Progress: 100%\n🏆 Badges: ${progress.badges.join(', ')}`,
  }, 200, origin);
}

async function handleBotStandup(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const body = (await request.json()) as { telegram_id?: string; goals?: string };
  if (!body.telegram_id) {
    return jsonResponse({ ok: false, error: 'Missing telegram_id' }, 400, origin);
  }
  const candidate = await findApplicationByTelegram(env, body.telegram_id);
  if (!candidate) {
    return jsonResponse({ ok: false, error: 'No application linked' }, 404, origin);
  }
  const taskName = `Standup — ${new Date().toISOString().split('T')[0]}`;
  let progress: ProgressInfo;
  if (candidate.kv) {
    const app = candidate.kv;
    if (!app.tasks.some((t) => t.name === taskName)) {
      app.tasks.push({ name: taskName, status: 'Done', channel: 'Telegram' });
      await kvPut(env, app);
    }
    progress = kvProgress(app);
  } else {
    if (env.NOTION_TASKS_DB_ID) {
      // The cron creates `Standup — today` each morning; mark it Done rather
      // than duplicating it. Fall back to creating if it doesn't exist.
      const existing = await notionRequest(env, 'POST', `/databases/${env.NOTION_TASKS_DB_ID}/query`, {
        filter: { and: [
          { property: 'Candidate', relation: { contains: candidate.id } },
          { property: 'Name', title: { equals: taskName } },
        ] },
      });
      const row = (existing.results || [])[0];
      if (row) {
        await notionRequest(env, 'PATCH', `/pages/${row.id}`, {
          properties: {
            'Status': { select: { name: 'Done' } },
            'Channel': { select: { name: 'Telegram' } },
            'Automated': { checkbox: true },
          },
        });
      } else {
        await notionRequest(env, 'POST', '/pages', {
          parent: { database_id: env.NOTION_TASKS_DB_ID },
          properties: {
            Name: { title: [{ text: { content: taskName } }] },
            Candidate: { relation: [{ id: candidate.id }] },
            Status: { select: { name: 'Done' } },
            Channel: { select: { name: 'Telegram' } },
            Automated: { checkbox: true },
            'Due Date': { date: { start: new Date().toISOString().split('T')[0] } },
          },
        });
      }
    }
    progress = await updateProgressOnApplication(env, candidate.id);
  }
  return jsonResponse({
    ok: true,
    message: `📝 Standup recorded.\n📊 Progress: ${Math.round(progress.percent * 100)}% (${progress.doneTasks}/${progress.totalTasks})`,
  }, 200, origin);
}

async function handleBotProgress(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const body = (await request.json()) as { telegram_id?: string };
  if (!body.telegram_id) {
    return jsonResponse({ ok: false, error: 'Missing telegram_id' }, 400, origin);
  }
  const candidate = await findApplicationByTelegram(env, body.telegram_id);
  if (!candidate) {
    return jsonResponse({ ok: false, error: 'No application linked to this Telegram account. Use /link <application_ref> first.' }, 404, origin);
  }
  if (candidate.kv) {
    const app = candidate.kv;
    const progress = kvProgress(app);
    return jsonResponse({
      ok: true,
      name: app.fullName || 'Founder',
      track: app.trackName,
      trackUrl: app.trackUrl,
      percent: Math.round(progress.percent * 100),
      doneTasks: progress.doneTasks,
      totalTasks: progress.totalTasks,
      badges: progress.badges,
      nextTask: progress.nextTask,
      message: `📊 Progress: ${Math.round(progress.percent * 100)}% (${progress.doneTasks}/${progress.totalTasks})\n🏆 Badges: ${progress.badges.join(', ') || 'none yet'}\n➡️ Next: ${progress.nextTask || 'all done 🎉'}`,
    }, 200, origin);
  }
  const progress = await calculateProgress(env, candidate.id);
  const props = candidate.properties;
  return jsonResponse({
    ok: true,
    name: props.Name?.title?.[0]?.plain_text || 'Founder',
    track: props['Founder OS Track']?.select?.name,
    trackUrl: props['Founder OS Track URL']?.url,
    percent: Math.round(progress.percent * 100),
    doneTasks: progress.doneTasks,
    totalTasks: progress.totalTasks,
    badges: progress.badges,
    nextTask: progress.nextTask,
    message: `📊 Progress: ${Math.round(progress.percent * 100)}% (${progress.doneTasks}/${progress.totalTasks})\n🏆 Badges: ${progress.badges.join(', ') || 'none yet'}\n➡️ Next: ${progress.nextTask || 'all done 🎉'}`,
  }, 200, origin);
}

async function handleAdminStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const auth = request.headers.get('authorization') || '';
  if (env.ADMIN_TOKEN && auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401, origin);
  }

  const statusCounts: Record<string, number> = {};
  const trackCounts: Record<string, number> = {};
  let approved = 0;
  let launched = 0;
  let progressSum = 0;
  let withProgress = 0;
  let notionTotal = 0;

  const count = (status: string, track: string, badges: string[], progressPct?: number) => {
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    trackCounts[track] = (trackCounts[track] || 0) + 1;
    if (status === 'Approved') approved++;
    if (badges.some((b) => b === 'Launched')) launched++;
    if (typeof progressPct === 'number') {
      progressSum += progressPct;
      withProgress++;
    }
  };

  if (notionConfigured(env) && env.NOTION_BUILD_DB_ID) {
    const data = await notionRequest(env, 'POST', `/databases/${env.NOTION_BUILD_DB_ID}/query`, { page_size: 100 });
    const results = data.results || [];
    notionTotal = results.length;
    for (const r of results) {
      const p = r.properties;
      count(
        p['Application Status']?.select?.name || 'New',
        p['Founder OS Track']?.select?.name || 'None',
        (p.Badges?.multi_select || []).map((b: any) => b.name),
        p['Progress %']?.number,
      );
    }
  }
  const kvApps = await kvList(env);
  for (const app of kvApps) {
    count(app.applicationStatus, app.trackName, kvProgress(app).badges, kvProgress(app).percent * 100);
  }
  const total = notionTotal + kvApps.length;

  return jsonResponse({
    ok: true,
    total,
    statusCounts,
    trackCounts,
    approved,
    launched,
    avgProgress: withProgress ? Math.round((progressSum / withProgress) * 100) : 0,
  }, 200, origin);
}

const SHOPIFY_SHOP_DOMAIN = 'brainsait.myshopify.com';
const SHOPIFY_API_VERSION = '2025-10';

async function shopifyGraphQL(env: Env, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(
    `https://${env.SHOPIFY_STORE_DOMAIN || SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN || '',
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  return res.json();
}

interface CustomerSyncInput {
  email: string;
  fullName?: string;
  phone?: string;
  country?: string;
  tags?: string[];
  acceptsMarketing?: boolean;
  applicationRef?: string;
  telegramId?: string;
}

/**
 * Upsert a Shopify customer (create by email, update if present) and opt them
 * into email marketing so they land in the store's email messaging centre.
 * Best-effort: never throws — callers treat the result as advisory.
 */
async function syncShopifyCustomer(env: Env, input: CustomerSyncInput, sendEmailInvite = true): Promise<{ ok: boolean; customerId?: string; action?: string; error?: string }> {
  if (!env.SHOPIFY_ADMIN_TOKEN) return { ok: false, error: 'SHOPIFY_ADMIN_TOKEN not configured' };
  if (!validateEmail(input.email)) return { ok: false, error: 'invalid email' };

  const nameParts = (input.fullName || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || ' ';

  const tags = new Set<string>(['storefront-registered']);
  for (const t of input.tags || []) tags.add(t);
  if (input.applicationRef) tags.add('build-applicant');
  if (input.telegramId) tags.add('forge-member');

  const marketing = input.acceptsMarketing !== false;
  const consent = marketing
    ? { emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: new Date().toISOString() } }
    : {};

  try {
    // Look up existing customer by email to upsert rather than duplicate.
    const lookup = await shopifyGraphQL(env, `query($q: String!) { customers(first: 1, query: $q) { edges { node { id tags } } } }`, { q: `email:${input.email}` });
    const existing = lookup?.data?.customers?.edges?.[0]?.node;

    if (existing) {
      const mergedTags = Array.from(new Set([...String(existing.tags || '').split(',').map((s: string) => s.trim()).filter(Boolean), ...tags])).join(', ');
      const res = await shopifyGraphQL(env, `mutation($input: CustomerInput!) { customerUpdate(input: $input) { customer { id } userErrors { field message } } }`, {
        input: {
          id: existing.id,
          firstName,
          lastName,
          phone: input.phone || null,
          tags: mergedTags,
        },
      });
      const errs = res?.errors || res?.data?.customerUpdate?.userErrors || [];
      if (errs.length > 0) return { ok: false, error: errs.map((e: any) => e.message).join('; ') };
      // Marketing consent must be set via its dedicated mutation on updates.
      if (marketing) {
        const consentRes = await shopifyGraphQL(env, `mutation($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) { customer { id } userErrors { field message } }
        }`, {
          input: {
            customerId: existing.id,
            emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN', consentUpdatedAt: new Date().toISOString() },
          },
        });
        const consentErrs = consentRes?.errors || consentRes?.data?.customerEmailMarketingConsentUpdate?.userErrors || [];
        if (consentErrs.length > 0) return { ok: false, error: consentErrs.map((e: any) => e.message).join('; ') };
      }
      return { ok: true, customerId: res?.data?.customerUpdate?.customer?.id, action: 'updated' };
    }

    const res = await shopifyGraphQL(env, `mutation($input: CustomerInput!, $invite: Boolean!) { customerCreate(input: $input, sendEmailInvite: $invite) { customer { id } userErrors { field message } } }`, {
      input: {
        email: input.email,
        firstName,
        lastName,
        phone: input.phone || null,
        tags: Array.from(tags).join(', '),
        ...consent,
      },
      invite: sendEmailInvite,
    });
    const errs = res?.errors || res?.data?.customerCreate?.userErrors || [];
    if (errs.length > 0) return { ok: false, error: errs.map((e: any) => e.message).join('; ') };
    return { ok: true, customerId: res?.data?.customerCreate?.customer?.id, action: 'created' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function handleCustomerSync(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  try {
    const body = (await request.json()) as CustomerSyncInput;
    if (!body.email) {
      return jsonResponse({ ok: false, error: 'Missing email' }, 400, origin);
    }
    // Public endpoint → throttle per IP so it can't be used to hammer
    // Shopify with arbitrary customer upserts.
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const limitKey = `sync:${ip}`;
    try {
      const count = Number((await env.APPLICATIONS.get(limitKey)) || 0);
      if (count >= 5) {
        return jsonResponse({ ok: false, error: 'Rate limited — try again later' }, 429, origin);
      }
      await env.APPLICATIONS.put(limitKey, String(count + 1), { expirationTtl: 3600 });
    } catch { /* best-effort */ }
    // No Shopify invite emails from an unauthenticated public endpoint —
    // that would let anyone spam-invite arbitrary addresses.
    const result = await syncShopifyCustomer(env, body, false);
    return jsonResponse({ ...result }, result.ok ? 200 : 502, origin);
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e) }, 500, origin);
  }
}

async function handleApply(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');

  try {
    const payload = (await request.json()) as ApplyPayload;

    if (!payload.fullName || !payload.email || !payload.identity) {
      return jsonResponse({ ok: false, error: 'Missing required fields: fullName, email, identity' }, 400, origin);
    }
    if (!validateEmail(payload.email)) {
      return jsonResponse({ ok: false, error: 'Invalid email address' }, 400, origin);
    }

    if (env.TURNSTILE_SECRET) {
      if (!payload.turnstileToken) {
        return jsonResponse({ ok: false, error: 'Missing Turnstile token' }, 403, origin);
      }
      const ok = await verifyTurnstile(payload.turnstileToken, env.TURNSTILE_SECRET);
      if (!ok) {
        return jsonResponse({ ok: false, error: 'Turnstile verification failed' }, 403, origin);
      }
    }

    if (payload.evidenceFile?.base64) {
      const buffer = decodeBase64File(payload.evidenceFile);
      if (buffer.byteLength > MAX_FILE_BYTES) {
        return jsonResponse({ ok: false, error: 'Evidence file too large (max 5 MB)' }, 413, origin);
      }
      const contentType = payload.evidenceFile.type || contentTypeFromName(payload.evidenceFile.name);
      if (!ALLOWED_EVIDENCE_TYPES.has(contentType)) {
        return jsonResponse({ ok: false, error: 'Unsupported file type. Use PDF or image (jpg/png/webp/gif)' }, 400, origin);
      }
    }

    const pricing = calculatePrice(
      {
        identity: payload.identity,
        profession: payload.profession,
      },
      payload.promoCode
    );

    const track = FOUNDER_OS_TRACKS[pricing.eligibilityId] || FOUNDER_OS_TRACKS.standard;
    const appRef = crypto.randomUUID();
    let evidenceUrl: string | undefined;

    if (payload.evidenceFile?.base64) {
      const key = `${appRef}/${safeFileName(payload.evidenceFile.name)}`;
      const buffer = decodeBase64File(payload.evidenceFile);
      const contentType = payload.evidenceFile.type || contentTypeFromName(payload.evidenceFile.name);
      await env.EVIDENCE_BUCKET.put(key, buffer, { httpMetadata: { contentType } });
      evidenceUrl = `https://build-apply.brainsait.org/evidence/${key}`;
    }
    // Notion is best-effort: if it is configured but fails (bad token, API
    // outage), the application is still persisted in KV so the Build page
    // works end-to-end. Upgrades to the full Notion CRM flow automatically
    // once a valid token/database is configured.
    let notionPage: { id: string; url: string } | null = null;
    let notionFailed = false;
    if (notionConfigured(env)) {
      try {
        notionPage = await createNotionPage(env, payload, pricing, appRef, track, evidenceUrl);
        try { await createInitialTasks(env, notionPage.id); } catch { /* non-fatal */ }
        try { await updateProgressOnApplication(env, notionPage.id); } catch { /* non-fatal */ }
      } catch {
        notionFailed = true;
      }
    }

    const kvApp: KvApplication = {
      ref: appRef,
      fullName: payload.fullName,
      email: payload.email,
      phone: payload.phone,
      country: payload.country,
      identity: payload.identity,
      profession: payload.profession,
      category: payload.category,
      organizationName: payload.organizationName,
      universityName: payload.universityName,
      website: payload.website,
      buildingDescription: payload.buildingDescription,
      tier: pricing.eligibilityId,
      trackName: track.name,
      trackUrl: track.url,
      finalPrice: pricing.finalPrice,
      discount: pricing.discount,
      paymentStatus: pricing.finalPrice === 0 ? 'Waived' : 'Pending',
      applicationStatus: 'New',
      notionUrl: notionPage?.url || undefined,
      evidenceKey: evidenceUrl,
      createdAt: new Date().toISOString(),
      tasks: notionPage ? [] : kvInitialTasks(),
    };
    await kvPut(env, kvApp);

    // Register the applicant as a Shopify customer (opt-in to email marketing)
    // so every BUILD applicant appears in the store's messaging centre.
    // No invite email yet — the paid webhook sends the partner invite.
    try {
      await syncShopifyCustomer(env, {
        email: payload.email,
        fullName: payload.fullName,
        phone: payload.phone,
        country: payload.country,
        applicationRef: appRef,
        tags: [`tier:${pricing.eligibilityId}`],
      }, false);
    } catch { /* non-fatal */ }

    await emitHubEvent(env, {
      type: 'build.apply',
      source: 'build-apply',
      data: {
        applicationId: appRef,
        email: payload.email,
        name: payload.fullName,
        identity: identityLabel(payload.identity),
        tier: pricing.eligibilityId,
        discount: pricing.discount,
        finalPrice: pricing.finalPrice,
        country: payload.country,
        paymentStatus: kvApp.paymentStatus,
        evidence: evidenceUrl,
      },
    });

    let checkoutUrl: string | undefined;
    if (pricing.finalPrice > 0) {
      const variantId = SHOPIFY_VARIANTS[pricing.eligibilityId] || SHOPIFY_VARIANTS.standard;
      const shop = env.SHOPIFY_STORE_DOMAIN || 'store.brainsait.org';
      const params = new URLSearchParams();
      params.set('id', variantId);
      params.set('quantity', '1');
      params.set('properties[eligibility_tier]', pricing.eligibilityId);
      params.set('properties[discount_percent]', String(pricing.discount));
      params.set('properties[final_price]', String(pricing.finalPrice));
      params.set('properties[application_ref]', appRef);
      params.set('properties[applicant_email]', payload.email);
      if (pricing.promoCode) {
        params.set('properties[promo_code]', pricing.promoCode);
      }
      // Promo codes are applied through Shopify's /discount/CODE flow, which
      // pre-applies the code to the cart and redirects to the product page.
      // (The bare `&discount=` param on /cart/add is not reliably honoured.)
      if (pricing.promoCode) {
        const code = encodeURIComponent(pricing.promoCode);
        const add = `https://${shop}/cart/add?${params.toString()}`;
        checkoutUrl = `https://${shop}/discount/${code}?redirect=${encodeURIComponent(add)}`;
      } else {
        checkoutUrl = `https://${shop}/cart/add?${params.toString()}`;
      }
    }

    await sendConfirmationEmail(env, payload, pricing, appRef, notionPage?.url || '', track, checkoutUrl);

    return jsonResponse(
      {
        ok: true,
        applicationId: appRef,
        notionUrl: notionPage?.url || '',
        storage: notionPage ? 'notion' : 'kv',
        notionDegraded: notionFailed || undefined,
        tier: pricing.eligibilityId,
        track: track.name,
        trackUrl: track.url,
        smartMatcherUrl: SMART_MATCHER_URL,
        discount: pricing.discount,
        promoCode: pricing.promoCode,
        originalPrice: pricing.originalPrice,
        finalPrice: pricing.finalPrice,
        checkoutUrl,
        message: pricing.finalPrice === 0
          ? 'Application received — your access is pending verification.'
          : 'Application received — complete payment to confirm your seat.',
      },
      200,
      origin,
    );
  } catch (err: any) {
    console.error('apply error', err);
    return jsonResponse({ ok: false, error: err.message || 'Internal error' }, 500, origin);
  }
}

function rewriteDemoHtml(html: string, slug: string): string {
  const prefix = `/demo/${slug}`;
  const base = `<base href="${prefix}/">`;
  // Inject <base> so relative links resolve under the proxy path.
  let out = html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  // Rewrite root-absolute URLs in common HTML attributes.
  out = out.replace(/((?:href|src|action|poster|data)\s*=\s*["'])\/(?!\/|demo\/)/gi, `$1${prefix}/`);
  // Rewrite srcset entries (absolute paths).
  out = out.replace(/(srcset\s*=\s*["'])(\/[^\s"']+)/gi, `$1${prefix}$2`);
  // Rewrite CSS url(/...) references.
  out = out.replace(/url\(\s*('|")?\/(?!\/)/gi, `url($1${prefix}/`);
  // Rewrite absolute upstream URLs back to the proxy path.
  out = out.replace(/https:\/\/[a-z0-9.-]+\.pages\.dev\//gi, `https://build-apply.brainsait.org${prefix}/`);
  return out;
}

async function handleDemoProxy(request: Request, env: Env, slug: string, pathRest: string): Promise<Response> {
  const origin = request.headers.get('origin');
  const host = DEMO_UPSTREAMS[slug];
  if (!host) {
    return jsonResponse({ ok: false, error: 'Demo not found' }, 404, origin);
  }
  const upstream = `https://${host}${pathRest || '/'}`;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36');
  const upstreamReq = new Request(upstream, { method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body });
  const res = await fetch(upstreamReq);

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    const text = await res.text();
    const rewritten = rewriteDemoHtml(text, slug);
    return new Response(rewritten, {
      status: res.status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(origin) },
    });
  }

  // Pass through assets; add CORS headers for direct fetching.
  const pass = new Headers(res.headers);
  pass.set('Content-Type', ct || 'application/octet-stream');
  const cors = corsHeaders(origin);
  for (const [k, v] of Object.entries(cors)) pass.set(k, v);
  return new Response(res.body, { status: res.status, headers: pass });
}

async function handleEvidence(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const key = decodeURIComponent(url.pathname.slice('/evidence/'.length));
  if (!key) {
    return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
  }
  const obj = await env.EVIDENCE_BUCKET.get(key);
  if (!obj) {
    return new Response('Not found', { status: 404, headers: corsHeaders(origin) });
  }
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  const filename = key.split('/').pop() || 'file';
  headers.set('Content-Disposition', `inline; filename="${filename}"`);
  if (obj.size) headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'build-apply' }, 200, origin);
    }

    if (url.pathname.startsWith('/demo/')) {
      const rest = url.pathname.slice('/demo/'.length);
      const slash = rest.indexOf('/');
      const slug = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
      const pathRest = slash === -1 ? '' : rest.slice(slash);
      return handleDemoProxy(request, env, slug, pathRest);
    }

    if (url.pathname === '/apply' && request.method === 'POST') {
      return handleApply(request, env);
    }

    if (url.pathname === '/customer/sync' && request.method === 'POST') {
      return handleCustomerSync(request, env);
    }

    if (url.pathname === '/webhook/shopify' && request.method === 'POST') {
      return handleShopifyWebhook(request, env);
    }

    if (url.pathname.startsWith('/certificate/') && request.method === 'GET') {
      return handleCertificate(request, env, decodeURIComponent(url.pathname.slice('/certificate/'.length)));
    }

    if (url.pathname.startsWith('/progress/') && request.method === 'GET') {
      return handleProgress(request, env, decodeURIComponent(url.pathname.slice('/progress/'.length)));
    }

    if (url.pathname === '/bot/link' && request.method === 'POST') {
      return handleBotLink(request, env);
    }

    if (url.pathname === '/bot/day' && request.method === 'POST') {
      return handleBotDay(request, env);
    }

    if (url.pathname === '/bot/progress' && request.method === 'POST') {
      return handleBotProgress(request, env);
    }

    if (url.pathname === '/admin/stats' && request.method === 'GET') {
      return handleAdminStats(request, env);
    }

    if (url.pathname === '/bot/standup' && request.method === 'POST') {
      return handleBotStandup(request, env);
    }

    if (url.pathname.startsWith('/evidence/') && request.method === 'GET') {
      return handleEvidence(request, env);
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404, origin);
  },
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await handleCron(event, env);
  },
};
