import { BUILD_CURRICULUM, curriculumForDay, curriculumDayForProgramStart } from './curriculum';
import { generateCertificatePdf } from './certificate-pdf';
import { signCertificateWithAdobe } from './adobe-sign';

export interface Env {
  EVIDENCE_BUCKET: R2Bucket;
  APPLICATIONS: KVNamespace;
  BUILD_DB: D1Database;
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
  MCP_HUB_KEY?: string;
  GITHUB_TOKEN?: string;
  // Personal Telegram onboarding for paid partners (the FORGE bot). Cohort
  // invite link is optional — the message works without it.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_COHORT_LINK?: string;
  // Airtable mirror of the Build pipeline (optional; activates when all
  // three are configured on the worker).
  AIRTABLE_API_KEY?: string;
  AIRTABLE_BASE_ID?: string;
  AIRTABLE_CANDIDATES_TABLE?: string;
  // Adobe Acrobat Sign — electronic signature for issued certificates.
  ADOBE_SIGN_INTEGRATION_KEY?: string;
  ADOBE_SIGN_CLIENT_SECRET?: string;
  ADOBE_SIGN_BASE?: string;
  ADOBE_SIGN_SIGNER_EMAIL?: string;
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
  githubUsername?: string;
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
  githubUsername?: string;
  buildingDescription?: string;
  promoCode?: string;
  turnstileToken?: string;
  evidenceFile?: { name: string; type: string; base64: string } | null;
  /** Installment plan: 'full' (one payment) | 'flex' (2×50%) | 'split' (3 payments). */
  plan?: string;
}

/* ─────────────────────────────────────────────────────────────────────
 * INSTALLMENT SYSTEM — strict tracking, follow-up and suspension.
 *
 * The BUILD Ticket (SAR 9,630) can be paid in installments. Every plan is
 * tracked in KV under `installment:<appRef>` with a per-payment schedule,
 * payment history and status. Each installment gets its own checkout URL
 * carrying `properties[installment_ref]` so the webhook can map partial
 * payments without ever mis-marking the application as fully paid.
 *
 * Reminder escalation (cron, daily): T-3d friendly → T-1d nudge → T+1d
 * urgent → T+3d final → T+7d warning → ≥14d OVERDUE → SUSPENDED (profile +
 * Notion + access revoked). Payment resumes → ACTIVE again.
 * ───────────────────────────────────────────────────────────────────── */

type InstallmentStatus = 'PENDING' | 'PAID' | 'OVERDUE';

interface Installment {
  no: number;
  label: string;        // e.g. "Down payment", "Month 2"
  amount: number;       // SAR
  dueAt: string;        // ISO date of first payment
  status: InstallmentStatus;
  paidAt?: string;
  orderId?: string;
  reminderStage: number; // 0..6, max level reached
}

interface InstallmentPlan {
  ref: string;
  email: string;
  fullName: string;
  phone?: string;
  plan: 'full' | 'flex' | 'split' | 'quarter';
  total: number;
  installments: Installment[];
  status: 'ACTIVE' | 'COMPLETED' | 'SUSPENDED';
  createdAt: string;
  suspendedAt?: string;
  suspendedReason?: string;
}

const INSTALLMENT_DEFS: Record<string, { label: string; share: number }[]> = {
  full: [{ label: 'Full payment', share: 1 }],
  flex: [
    { label: 'Down payment (50%)', share: 0.5 },
    { label: 'Balance (50%)', share: 0.5 },
  ],
  split: [
    { label: 'Down payment', share: 1 / 3 },
    { label: 'Installment 2', share: 1 / 3 },
    { label: 'Final installment', share: 1 - 2 / 3 },
  ],
  quarter: [
    { label: 'Down payment (25%)', share: 0.25 },
    { label: 'Installment 2', share: 0.25 },
    { label: 'Installment 3', share: 0.25 },
    { label: 'Final installment', share: 0.25 },
  ],
};

function buildInstallmentSchedule(ref: string, email: string, fullName: string, phone: string | undefined, plan: string, total: number, today = new Date()): InstallmentPlan {
  const defs = INSTALLMENT_DEFS[plan] || INSTALLMENT_DEFS.full;
  const now = today.toISOString();
  // Compute non-final amounts from the share, then make the LAST installment
  // absorb the rounding remainder so the schedule always sums EXACTLY to total
  // (e.g. quarter: 2408 + 2408 + 2407 + 2407 = 9630, not 9632).
  const amounts: number[] = defs.map((d, i) => (i === defs.length - 1 ? 0 : Math.round(d.share * total)));
  const paidSoFar = amounts.reduce((a, b) => a + b, 0);
  amounts[amounts.length - 1] = total - paidSoFar;
  const installments: Installment[] = defs.map((d, i) => {
    const due = new Date(now);
    due.setUTCDate(due.getUTCDate() + (i === 0 ? 0 : 30 * i));
    return {
      no: i + 1,
      label: d.label,
      amount: amounts[i],
      dueAt: due.toISOString(),
      status: 'PENDING',
      reminderStage: 0,
    };
  });
  return {
    ref, email, fullName, phone, plan: plan as InstallmentPlan['plan'], total, installments,
    status: 'ACTIVE', createdAt: now,
  };
}

async function getInstallmentPlan(env: Env, ref: string): Promise<InstallmentPlan | null> {
  try {
    const raw = await env.APPLICATIONS.get(`installment:${ref}`, 'json');
    return raw as InstallmentPlan | null;
  } catch { return null; }
}

async function saveInstallmentPlan(env: Env, plan: InstallmentPlan): Promise<void> {
  try { await env.APPLICATIONS.put(`installment:${refKey(plan.ref)}`, JSON.stringify(plan), { expirationTtl: 730 * 24 * 60 * 60 }); } catch { /* best-effort */ }
}
function refKey(ref: string): string {
  // KV keys may not contain some characters; keep refs compact.
  return ref.replace(/[^a-zA-Z0-9-]/g, '');
}

function installmentPaymentUrl(env: Env, appRef: string, plan: InstallmentPlan, no: number): string {
  const inst = plan.installments.find((x) => x.no === no) || plan.installments[0];
  const variantId = SHOPIFY_VARIANTS.standard;
  const shop = env.SHOPIFY_STORE_DOMAIN || 'store.brainsait.org';
  const params = new URLSearchParams();
  params.set('id', variantId);
  params.set('quantity', '1');
  params.set('properties[eligibility_tier]', 'standard');
  params.set('properties[final_price]', String(inst.amount));
  params.set('properties[application_ref]', appRef);
  params.set('properties[installment_ref]', `inst-${appRef}-${no}`);
  params.set('properties[installment_no]', String(no));
  params.set('properties[applicant_email]', plan.email);
  return `https://${shop}/cart/add?${params.toString()}`;
}

/** Find an installment by its `installment_ref` and mark it paid. */
async function markInstallmentPaid(env: Env, ref: string, no: number, orderId: string, paidAt?: string): Promise<{ ok: boolean; plan?: InstallmentPlan; completed?: boolean; error?: string }> {
  const plan = await getInstallmentPlan(env, ref);
  if (!plan) return { ok: false, error: 'no installment plan' };
  const inst = plan.installments.find((x) => x.no === no);
  if (!inst) return { ok: false, error: 'installment not found' };
  if (inst.status === 'PAID') return { ok: true, plan, completed: false };
  inst.status = 'PAID';
  inst.paidAt = paidAt || new Date().toISOString();
  inst.orderId = orderId;
  inst.reminderStage = 6;
  const allPaid = plan.installments.every((x) => x.status === 'PAID');
  if (allPaid) plan.status = 'COMPLETED';
  else plan.status = plan.status === 'SUSPENDED' ? 'ACTIVE' : 'ACTIVE';
  await saveInstallmentPlan(env, plan);
  // Broadcast the payment across the ecosystem (Notion, Airtable, hub, GitHub, KB).
  try {
    await broadcastInstallment(env, plan, allPaid ? 'completed' : 'paid');
  } catch { /* best-effort */ }
  return { ok: true, plan, completed: allPaid };
}

/** Serialize a plan for API/UI consumption (never expose internal reminder state). */
function planPublicView(plan: InstallmentPlan): Record<string, unknown> {
  return {
    ref: plan.ref,
    plan: plan.plan,
    total: plan.total,
    status: plan.status,
    createdAt: plan.createdAt,
    suspendedAt: plan.suspendedAt,
    installments: plan.installments.map((i) => ({
      no: i.no, label: i.label, amount: i.amount, dueAt: i.dueAt, status: i.status, paidAt: i.paidAt,
    })),
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * ACCESS CAPABILITIES — the BUILD Ticket is a 14-day limited-access
 * resource: partners build with our tools during the sprint, but full
 * DEPLOY / LAUNCH / MARKETING unlock only after FULL payment.
 *   · paid fully   → deploy, launch, marketing unlocked (14-day sprint)
 *   · current plan → building resources unlocked; deploy/launch/marketing
 *                    gated until the balance is settled
 *   · suspended    → everything gated EXCEPT the Second Brain public link
 * ───────────────────────────────────────────────────────────────────── */
interface AccessCapabilities {
  level: 'full' | 'building' | 'suspended';
  deploy: boolean;
  launch: boolean;
  marketing: boolean;
  buildResources: boolean;
  secondBrainPublic: boolean;
  secondBrainUrl: string;
}

function computeAccessCapabilities(paymentStatus: string | undefined, planStatus: string | undefined): AccessCapabilities {
  const secondBrainUrl = 'https://fadil369.notion.site/Ultimate-Brain-3bc3479c6f628177afd7fb7e9224c19c';
  const fullyPaid = planStatus === 'COMPLETED' || paymentStatus === 'Paid';
  const suspended = planStatus === 'SUSPENDED';
  if (fullyPaid) {
    return { level: 'full', deploy: true, launch: true, marketing: true, buildResources: true, secondBrainPublic: true, secondBrainUrl };
  }
  if (suspended) {
    // Suspended: no deploy / no launch / no marketing until full payment.
    // The Second Brain template stays shareable via its public Notion link.
    return { level: 'suspended', deploy: false, launch: false, marketing: false, buildResources: false, secondBrainPublic: true, secondBrainUrl };
  }
  // Current on installments (or one-time unpaid): building resources for the
  // 14-day sprint are available, but deploy/launch/marketing are gated.
  return { level: 'building', deploy: false, launch: false, marketing: false, buildResources: true, secondBrainPublic: true, secondBrainUrl };
}

/** Fetch the installment plan status for an application ref (if any). */
async function planStatusForRef(env: Env, appRef: string): Promise<string | undefined> {
  try {
    const plan = await getInstallmentPlan(env, appRef);
    return plan?.status;
  } catch { return undefined; }
}

/** Send an installment reminder via email + SMS (best-effort). */
async function sendInstallmentReminder(env: Env, plan: InstallmentPlan, inst: Installment, stage: number): Promise<void> {
  const daysOver = Math.max(0, Math.floor((Date.now() - new Date(inst.dueAt).getTime()) / 86400000));
  const paymentUrl = installmentPaymentUrl(env, plan.ref, plan, inst.no);
  const subject = stage <= 2
    ? (plan.plan === 'full' ? 'Your BrainSAIT BUILD Ticket payment' : `BUILD Ticket — ${inst.label} due`)
    : `⚠️ ${inst.label} overdue — action required`;

  const messages: Record<number, { title: string; body: string }> = {
    0: { title: 'Reminder', body: `This is a friendly reminder that your ${inst.label} (SAR ${inst.amount}) is due on ${inst.dueAt.slice(0, 10)}.` },
    1: { title: 'Payment due tomorrow', body: `Your ${inst.label} of SAR ${inst.amount} is due tomorrow. Please complete it to keep your BUILD access active.` },
    2: { title: 'Payment due today', body: `Your ${inst.label} of SAR ${inst.amount} is due TODAY. Complete payment now to avoid disruption.` },
    3: { title: 'Payment overdue', body: `Your ${inst.label} of SAR ${inst.amount} is ${daysOver} day(s) overdue. Pay now to keep your account active.` },
    4: { title: 'Final reminder', body: `This is your FINAL reminder. Your ${inst.label} of SAR ${inst.amount} is ${daysOver} day(s) overdue. If not paid within 7 days your account will be suspended.` },
    5: { title: 'Suspension imminent', body: `Your account will be SUSPENDED in ${Math.max(0, 14 - daysOver)} day(s) unless you settle your overdue ${inst.label} (SAR ${inst.amount}).` },
  };

  const m = messages[Math.min(stage, 5)] || messages[0];
  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;line-height:1.6;">
    <h2 style="color:#131320;">${m.title}</h2>
    <p>Hi ${escapeHtml(plan.fullName || plan.email.split('@')[0])},</p>
    <p>${m.body}</p>
    <p><strong>Due amount:</strong> SAR ${inst.amount}<br/>
       <strong>Due date:</strong> ${inst.dueAt.slice(0, 10)}<br/>
       <strong>Application:</strong> ${plan.ref}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:#e9c46a;border-radius:999px;padding:13px 30px;">
      <a href="${paymentUrl}" style="color:#131320;text-decoration:none;font-weight:700;font-size:14px;">Pay now →</a>
    </td></tr></table>
    <p style="color:#666;font-size:13px;">Your BUILD access stays active while you are current on installments. Unpaid balances past 14 days trigger account suspension.</p>
  </div>`;

  if (env.RESEND_API_KEY && plan.email) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.RESEND_FROM_EMAIL || RESEND_FROM, to: plan.email, subject, html }),
      });
    } catch { /* best-effort */ }
  }

  // SMS (via the ecosystem hub — Twilio → KonsoleH → email fallback).
  if (plan.phone) {
    try {
      await emitHubEvent(env, {
        type: 'installment.reminder',
        source: 'build-apply',
        notify_sms: true,
        sms_text: `BrainSAIT BUILD: ${m.title}. ${inst.label} SAR ${inst.amount} due ${inst.dueAt.slice(0, 10)}. Pay to keep access: ${paymentUrl}`.slice(0, 160),
        data: { applicationId: plan.ref, installmentNo: inst.no, amount: inst.amount, stage, paymentUrl },
      });
    } catch { /* best-effort */ }
  }
}

/**
 * Daily installment sweep: escalate reminders and suspend overdue plans.
 * Returns a summary of actions taken. Called from handleCron.
 */
async function runInstallmentSweep(env: Env): Promise<{ scanned: number; reminded: number; suspended: number; resumed: number }> {
  const result = { scanned: 0, reminded: 0, suspended: 0, resumed: 0 };
  let cursor: string | undefined;
  do {
    const listed = await env.APPLICATIONS.list({ prefix: 'installment:', cursor });
    result.scanned += listed.keys.length;
    for (const key of listed.keys) {
      const ref = key.name.replace(/^installment:/, '');
      const plan = await getInstallmentPlan(env, ref);
      if (!plan || plan.status === 'COMPLETED') continue;
      const now = Date.now();
      let reminded = false;

      for (const inst of plan.installments) {
        if (inst.status === 'PAID') continue;
        const dueMs = new Date(inst.dueAt).getTime();
        const daysToDue = Math.ceil((dueMs - now) / 86400000);
        const daysOver = Math.floor((now - dueMs) / 86400000);

        // Stage the reminder.
        let stage = 0;
        if (daysToDue === 3) stage = 1;
        else if (daysToDue === 1) stage = 2;
        else if (daysToDue <= 0) stage = 3 + Math.min(2, Math.floor(daysOver / 2)); // 3,4,5
        if (stage > inst.reminderStage) {
          inst.reminderStage = stage;
          await sendInstallmentReminder(env, plan, inst, stage);
          reminded = true;
          result.reminded++;
        }

        // SUSPEND at ≥14 days overdue.
        if (daysOver >= 14 && plan.status === 'ACTIVE') {
          plan.status = 'SUSPENDED';
          plan.suspendedAt = new Date().toISOString();
          plan.suspendedReason = `Installment ${inst.no} (${inst.label}) ${daysOver} days overdue`;
          await suspendPartnerAccess(env, plan, plan.suspendedReason);
          result.suspended++;
          // Full ecosystem broadcast: Notion, Airtable, hub (Telegram/SMS/n8n), GitHub revoke, KB.
          await broadcastInstallment(env, plan, 'suspended', plan.suspendedReason);
        }
      }
      await saveInstallmentPlan(env, plan);
      if (reminded) {
        await emitHubEvent(env, {
          type: 'installment.reminder',
          source: 'build-apply',
          data: { applicationId: plan.ref, reminded: true },
        });
      }
    }
    cursor = (listed as any).cursor;
  } while (cursor);
  return result;
}

/** Suspend (or re-activate) a partner's access across the ecosystem. */
async function suspendPartnerAccess(env: Env, plan: InstallmentPlan, reason: string, suspend = true): Promise<void> {
  try {
    await fetch('https://portal.brainsait.de/api/integration/partner-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: plan.email,
        status: suspend ? 'suspended' : 'active',
        reason,
        applicationId: plan.ref,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* best-effort */ }

  // Also flip the Notion candidate page to a Suspended badge (if we can find it).
  try {
    const found = await findApplicationByRef(env, plan.ref);
    if (found?.id && env.NOTION_TOKEN) {
      await notionRequest(env, 'PATCH', `/pages/${found.id}`, {
        properties: {
          'Badges': { multi_select: [{ name: suspend ? 'Suspended' : 'Activated' }] },
          'Last Activity': { date: { start: new Date().toISOString() } },
        },
      });
    }
  } catch { /* best-effort */ }

  await emitHubEvent(env, {
    type: suspend ? 'partner.suspended' : 'partner.resumed',
    source: 'build-apply',
    data: { applicationId: plan.ref, email: plan.email, reason },
  });
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
const FOUNDER_OS_URL = 'https://fadil369.notion.site/Founder-OS-3ba3479c6f628117966fd1be6c120ac2';
const ULTIMATE_BRAIN_BUILD_URL = 'https://fadil369.notion.site/Ultimate-Brain-30b3479c6f62801083b8ce6842e5df45';
const CALENDAR_URL = 'https://calendar.app.google/rAqiE6pNumtECdnd7';
const ACCOUNT_URL = 'https://account.brainsait.org';
const BUILD_TRACK_URL = 'https://fadil369.github.io/track';
const BUILD_CERT_BASE = 'https://build-apply.brainsait.org';
const GITHUB_PROFILE_URL = 'https://github.com';

// All transactional mail is sent from the verified Resend domain. Verified
// working sender (2026-08-14, confirmed delivered to Gmail):
//   orders@brainsait.org  (brainsait.org is verified in Resend)
//
// NOTE: "resend.brainsait.org" is NOT verified in Resend — only its click-
// tracking CNAME (links1.resend-dns.com) exists in DNS; the DKIM TXT record
// (resend._domainkey.resend.brainsait.org) has not been added, and the
// Resend dashboard/API cannot produce it with the send-only keys available.
// It is NOT used as a sender until its DKIM is added and Resend marks the
// domain verified. Sending to fadil@brainsait.org is additionally blocked by
// Apple iCloud's forwarding policy (554 HM08) — brainsait.org mail routes to
// iCloud via Cloudflare Email Routing, and Apple rejects externally-sent
// messages forwarded into that mailbox. Use a real inbox for ops reports.
const RESEND_FROM = 'BrainSAIT <orders@brainsait.org>';

// Airtable mirror — "Build Candidates" table in the brainsait base
// (appE7sxyyLHrCQBSe / tblGLOozm8LcUeXCD). Gated on secrets so the worker
// runs identically with or without Airtable configured.
const AIRTABLE_BASE = 'appE7sxyyLHrCQBSe';
const AIRTABLE_CANDIDATES = 'tblGLOozm8LcUeXCD';

// Launch promo codes — validated server-side. The storefront previews the
// same codes via pricingEngine.ts; Shopify checkout applies the code. These
// discount codes are ACTIVE in the store (verified 2026-08-14, via the app's
// expanded write_discounts scope).
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
// standard variant of the BUILD Ticket product. Verified live 2026-08-14:
// product "BUILD Ticket — Incubation Pass" (handle build-ticket) carries
// exactly one ACTIVE variant (BSP-BUILD-TICKET-IDENTITY @ 9,630 SAR); the
// obsolete tiered product "brainsait-incubation-program" is archived.
const SHOPIFY_VARIANTS: Record<string, string> = {
  standard: '45947217870931',
};

const FOUNDER_OS_TRACKS: Record<string, { name: string; url: string }> = {
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
  // a discount on top of the launch price — codes LAUNCH10 (10%) and
  // FOUNDER15 (15%) are ACTIVE in the store.
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
    'GitHub Username': payload.githubUsername
      ? { rich_text: [{ text: { content: payload.githubUsername } }] }
      : undefined,
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
  const priceText = `${pricing.finalPrice.toLocaleString(ar ? 'ar-SA' : 'en-SA')} SAR`;
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
        <p>استلمنا طلبك بنجاح. إليك ملخص تذكرة البناء:</p>
        <ul>
          <li><strong>التذكرة:</strong> ${escapeHtml(tierTitle)} — سعر موحد للجميع</li>
          ${originalLine}
          <li><strong>السعر النهائي:</strong> ${priceText}</li>
          <li><strong>رقم الطلب:</strong> ${appRef}</li>
          ${promoLine}
        </ul>
        <p style="margin:1rem 0;"><a href="${SMART_MATCHER_URL}">اكتشف مسارك الأمثل عبر Smart Program Matcher →</a></p>
        ${checkoutUrl ? `<p style="margin:1.5rem 0;"><a href="${checkoutUrl}" style="background:#e9c46a;color:#131320;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:700;">إتمام الدفع</a></p>` : ''}
        <p style="margin:1rem 0 0;color:#666;font-size:0.9rem;">بعد الدفع: يُفتح حسابك، صفحة الإعداد في Notion، ومستودع GitHub الخاص بك تلقائياً.</p>
        ${notionUrl ? `<p style="color:#666;font-size:0.9rem;">يمكنك متابعة حالة طلبك في Notion: <a href="${notionUrl}">${notionUrl}</a></p>` : ''}
      </div>`
    : `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;line-height:1.6;">
        <h2 style="color:#131320;">Hi ${escapeHtml(payload.fullName)} 👋</h2>
        <p>We received your application successfully. Here's your Build Ticket summary:</p>
        <ul>
          <li><strong>Ticket:</strong> ${escapeHtml(tierTitle)} — one flat price for everyone</li>
          ${originalLine}
          <li><strong>Final price:</strong> ${priceText}</li>
          <li><strong>Application ref:</strong> ${appRef}</li>
          ${promoLine}
        </ul>
        <p style="margin:1rem 0;"><a href="${SMART_MATCHER_URL}">Find your best path with the Smart Program Matcher →</a></p>
        ${checkoutUrl ? `<p style="margin:1.5rem 0;"><a href="${checkoutUrl}" style="background:#e9c46a;color:#131320;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:700;">Complete payment</a></p>` : ''}
        <p style="margin:1rem 0 0;color:#666;font-size:0.9rem;">After payment your customer account, Notion onboarding, and your own GitHub repo are provisioned automatically.</p>
        ${notionUrl ? `<p style="color:#666;font-size:0.9rem;">Track your application in Notion: <a href="${notionUrl}">${notionUrl}</a></p>` : ''}
      </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || RESEND_FROM,
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
    channel?: 'Notion' | 'Email' | 'Telegram' | 'GitHub';
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

const GITHUB_TEMPLATE_OWNER = 'Fadil369';
const GITHUB_TEMPLATE_REPO = 'brainsait-build-starter';

/**
 * Give a paid candidate a real, isolated GitHub repo generated from the BUILD
 * starter template, with them invited as an outside collaborator scoped to
 * that one repo only — never org-wide. Idempotent via KV. No-ops silently
 * when no GitHub username is on file (the flat intake collects it at apply
 * time; candidates who skip it can add it later on the Notion record — the
 * webhook re-runs provisioning idempotently once it is present).
 */
async function provisionGitHubAccess(env: Env, applicationRef: string, githubUsername?: string): Promise<void> {
  console.log(`provisionGitHubAccess called: ref=${applicationRef} username=${githubUsername || '(none)'} hasToken=${!!env.GITHUB_TOKEN}`);
  if (!env.GITHUB_TOKEN) {
    console.log('provisionGitHubAccess: early return, missing token');
    return;
  }

  const dedupKey = `github-provisioned:${applicationRef}`;
  const ghHeaders = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'brainsait-build-apply',
  };
  const repoName = `build-${applicationRef.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60)}`;

  // If a repo was already provisioned, only fall through to a *late invite* when
  // the applicant supplied a username after the fact. Otherwise fully idempotent.
  const existing = env.APPLICATIONS
    ? ((await env.APPLICATIONS.get(dedupKey, 'json')) as { repoUrl?: string; githubUsername?: string } | null)
    : null;

  let repo = { html_url: '', full_name: '' };
  if (existing?.repoUrl) {
    repo.html_url = existing.repoUrl;
    repo.full_name = existing.repoUrl.replace(/^https?:\/\/github\.com\//, '');
    if (!githubUsername || (existing.githubUsername && existing.githubUsername === githubUsername)) {
      console.log(`provisionGitHubAccess: repo already provisioned for ${applicationRef}, skipping`);
      return;
    }
  } else {
    const createRes = await fetch(
      `https://api.github.com/repos/${GITHUB_TEMPLATE_OWNER}/${GITHUB_TEMPLATE_REPO}/generate`,
      {
        method: 'POST',
        headers: ghHeaders,
        body: JSON.stringify({ owner: GITHUB_TEMPLATE_OWNER, name: repoName, private: false, include_all_branches: false }),
      },
    );
    if (!createRes.ok) {
      console.error(`GitHub repo generate failed for ${applicationRef}: ${createRes.status} ${await createRes.text()}`);
      return;
    }
    repo = (await createRes.json()) as { html_url: string; full_name: string };
  }

  if (githubUsername) {
    const inviteRes = await fetch(
      `https://api.github.com/repos/${repo.full_name}/collaborators/${encodeURIComponent(githubUsername)}`,
      { method: 'PUT', headers: ghHeaders, body: JSON.stringify({ permission: 'push' }) },
    );
    if (!inviteRes.ok) {
      console.error(`GitHub collaborator invite failed for ${applicationRef} -> ${githubUsername}: ${inviteRes.status}`);
      // Repo exists even if the invite failed; still record it so we don't re-create on retry.
    }
  } else {
    console.log(`provisionGitHubAccess: repo ${repo.full_name} ready; no githubUsername yet — invite deferred`);
  }

  if (env.APPLICATIONS && repo.html_url) {
    await env.APPLICATIONS.put(
      dedupKey,
      JSON.stringify({ repoUrl: repo.html_url, githubUsername: githubUsername || null, provisionedAt: new Date().toISOString() }),
    );
  }
}

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
    { name: 'Invite to GitHub repository', status: 'To Do', channel: 'GitHub' },
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

/* ─────────────────────────────────────────────────────────────────────
 * D1 CENTRAL STUDENT STATE — the single source of truth for partner state
 * across the whole ecosystem (Telegram, email, simulator, admin dashboard).
 * Falls back gracefully when D1 is not configured; all existing KV/Notion
 * flows continue to work independently.
 * ───────────────────────────────────────────────────────────────────── */

/** Upsert a student record in the central D1 database.
 *  Keys email-normalized so lookups are case‑insensitive.
 */
async function d1UpsertStudent(env: Env, email: string, data: Record<string, string | number | boolean | null>): Promise<void> {
  const norm = email.toLowerCase();
  const now = new Date().toISOString();
  const keys = Object.keys(data);
  if (keys.length === 0) return;
  const cols = keys.join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map((k) => data[k]);
  const updates = keys.map((k) => `${k}=excluded.${k}`).join(', ');
  try {
    await env.BUILD_DB.prepare(
      `INSERT INTO students (email, ${cols}, created_at, updated_at) VALUES (?, ${placeholders}, ?, ?)
       ON CONFLICT(email) DO UPDATE SET ${updates}, updated_at=excluded.updated_at`
    ).bind(norm, ...values, now, now).run();
  } catch { /* best-effort — KV/Notion remain authoritative */ }
  // Also update KV for backward compatibility (best-effort).
  try {
    const existing = await env.APPLICATIONS.get(`student:${norm}`, 'json');
    if (existing) { Object.assign(existing, data); await env.APPLICATIONS.put(`student:${norm}`, JSON.stringify(existing)); }
    else await env.APPLICATIONS.put(`student:${norm}`, JSON.stringify({ email: norm, ...data, updatedAt: now }));
  } catch { /* best-effort */ }
}

/** Read a student record from the central D1 database. */
async function d1GetStudent(env: Env, email: string): Promise<Record<string, unknown> | null> {
  const norm = email.toLowerCase();
  try {
    const row = await env.BUILD_DB.prepare(`SELECT * FROM students WHERE email = ?`).bind(norm).all();
    const results = (row as { results?: Record<string, unknown>[] }).results || [];
    return results.length ? results[0] : null;
  } catch { return null; }
}

/** Log an ecosystem event (Telegram start, simulator screenshot, day complete, etc.)
 *  into the central D1 events table, then fire a best‑effort async fan‑out via
 *  ctx.waitUntil so the caller's response is never blocked on side effects.
 */
async function d1LogEvent(ctx: ExecutionContext, env: Env, eventType: string, studentEmail: string, payload: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  try {
    await env.BUILD_DB.prepare(
      `INSERT INTO events (event_type, student_email, payload, created_at) VALUES (?, ?, ?, ?)`
    ).bind(eventType, studentEmail.toLowerCase(), JSON.stringify(payload), now).run();
  } catch { /* best-effort */ }
  // Async fan‑out via waitUntil — don't block the request.
  ctx.waitUntil(fanoutEvent(env, eventType, studentEmail, payload));
}

/** Fan‑out a single ecosystem event so all subsystems can react. */
async function fanoutEvent(env: Env, eventType: string, studentEmail: string, payload: Record<string, unknown>): Promise<void> {
  // 1. Notion — append a note to the candidate page (if configured)
  try {
    if (!env.NOTION_TOKEN || !env.NOTION_BUILD_DB_ID) return;
    const candidate = await findApplicationByRef(env, studentEmail);
    if (!candidate?.id) return;
    const lines = [
      `🔔 ${eventType.replace('.', ' ')} — ${new Date().toISOString()}`,
      ...(payload && Object.keys(payload).length ? Object.entries(payload).map(([k, v]) => `• ${k}: ${String(v)}`) : []).join('\n'),
    ].filter(Boolean).join('\n');
    await notionRequest(env, 'PATCH', `/pages/${candidate.id}`, {
      properties: {
        'Last Activity': { date: { start: new Date().toISOString() } },
        Notes: { rich_text: [{ text: { content: lines } }] },
      },
    });
  } catch { /* best-effort */ }

  // 2. Hub event bus — Telegram / SMS / n8n react to every event.
  try {
    const base = env.HUB_URL || 'https://brainsait.de';
    await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Key': env.HUB_KEY || '' },
      body: JSON.stringify({ type: eventType, source: 'build-apply', data: { studentEmail, payload } }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* best-effort */ }

  // 3. Telegram — send a contextual message (welcome, day content, certificate).
  try {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    const student = await d1GetStudent(env, studentEmail);
    const chatId = student?.telegram_chat_id;
    if (!chatId) return;
    const appRef = String(student?.applicationRef || student?.ref || '');
    const trackUrl = `${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}`;
    const lines = [
      `🔔 ${eventType.replace('.', ' ')}`,
      trackUrl ? `📊 ${trackUrl}` : '',
    ].filter(Boolean).join('\n');
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* best-effort */ }
}

/**
 * Subscription day-advance — every successful payment-mandate billing cycle
 * unlocks the next curriculum day in D1 and pings the partner on Telegram.
 * Capped at day 15 (16 days = 0..15). Idempotent at the cap.
 */
async function advanceStudentDay(env: Env, email: string, source: string): Promise<{ ok: boolean; day?: number; error?: string }> {
  const norm = email.toLowerCase().trim();
  if (!norm) return { ok: false, error: 'missing email' };
  const stu = await d1GetStudent(env, norm);
  if (!stu) return { ok: false, error: 'student not found in D1' };
  const current = Number(stu.current_day || 0);
  const next = Math.min(current + 1, 15);
  if (next <= current) return { ok: true, day: next }; // already at final day

  const now = new Date().toISOString();
  try {
    await env.BUILD_DB.prepare(`UPDATE students SET current_day = ?, updated_at = ? WHERE email = ?`).bind(next, now, norm).run();
  } catch { return { ok: false, error: 'D1 update failed' }; }

  // Log the event into the central stream.
  try {
    await env.BUILD_DB.prepare(
      `INSERT INTO events (event_type, student_email, payload, created_at) VALUES (?, ?, ?, ?)`
    ).bind('subscription.day_advanced', norm, JSON.stringify({ day: next, source }), now).run();
  } catch { /* best-effort */ }

  // Telegram ping (best-effort).
  const chatId = stu.telegram_chat_id;
  if (chatId && env.TELEGRAM_BOT_TOKEN) {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `📈 سُجّلت دفعة قسطك بنجاح — تقدّمت إلى اليوم ${next}. أكمل مختبر اليوم التالي في عقلك الثاني.`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* best-effort */ }
  }
  return { ok: true, day: next };
}

/* ─────────────────────────────────────────────────────────────────────
 * PRODUCT REVIEWS — D1-backed capture + retrieval. Self-contained today;
 * mirrors to Shopify's Product Reviews API once that dev-app token lands.
 * ───────────────────────────────────────────────────────────────────── */

async function handleReviews(env: Env, slug: string, origin: string | null): Promise<Response> {
  if (!slug) return jsonResponse({ ok: false, error: 'missing product slug' }, 400, origin);
  try {
    const rows = await env.BUILD_DB.prepare(
      `SELECT rating, name, body, created_at FROM reviews WHERE product_slug = ? ORDER BY id DESC LIMIT 50`
    ).bind(slug).all();
    const reviews = (rows as any).results || [];
    const n = reviews.length;
    const avg = n ? Math.round((reviews.reduce((s: number, r: any) => s + Number(r.rating || 0), 0) / n) * 10) / 10 : 0;
    return jsonResponse({ ok: true, slug, count: n, average: avg, reviews }, 200, origin);
  } catch {
    return jsonResponse({ ok: false, error: 'reviews unavailable' }, 500, origin);
  }
}

async function handleSubmitReview(env: Env, slug: string, body: { rating?: number; name?: string; body?: string }, origin: string | null): Promise<Response> {
  const rating = Math.max(1, Math.min(5, Number(body.rating || 5)));
  const name = String(body.name || 'Anonymous').slice(0, 80);
  const text = String(body.body || '').slice(0, 1000);
  if (!slug || !text.trim()) return jsonResponse({ ok: false, error: 'slug and body required' }, 400, origin);
  try {
    await env.BUILD_DB.prepare(
      `INSERT INTO reviews (product_slug, rating, name, body, created_at) VALUES (?, ?, ?, ?, ?)`
    ).bind(slug, rating, name, text.trim(), new Date().toISOString()).run();
    return jsonResponse({ ok: true, slug, rating }, 200, origin);
  } catch {
    return jsonResponse({ ok: false, error: 'review not saved' }, 500, origin);
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * BASMA RECOMMENDER — the "which track?" matcher behind checkout/chat.
 * Rule-based (deterministic, zero-latency) so it works everywhere; the
 * same contract can be swapped for an LLM call without changing callers.
 * ───────────────────────────────────────────────────────────────────── */

interface RecommendInput {
  goal?: string;      // learn | build | solution | sell | automate
  stage?: string;     // idea | validating | scaling | established
  budget?: number;
  time?: number;      // weeks available
  lang?: string;
}

function recommendTrack(input: RecommendInput): { track: string; trackAr: string; reason: string; reasonAr: string; products: string[] } {
  const g = String(input.goal || '').toLowerCase();
  const stage = String(input.stage || '').toLowerCase();
  const time = Number(input.time || 0);
  const budget = Number(input.budget || 0);

  // SOLUTIONS — need a ready, production system now (or enterprise budget).
  if (g.includes('solution') || g.includes('sell') || g.includes('enterprise') || budget >= 20000) {
    return {
      track: 'SOLUTIONS',
      trackAr: 'حلول',
      reason: 'You need a production-ready system or an enterprise build — not a course.',
      reasonAr: 'أنت تحتاج نظامًا جاهزًا للإنتاج أو بناءً مؤسسيًا — وليس دورة.',
      products: ['abeer-connected-healthcare-platform', 'ai-claims-reconciliation'],
    };
  }
  // BUILD — you want to build/launch a business or product.
  if (g.includes('build') || g.includes('startup') || g.includes('business') || g.includes('incubat') || g.includes('found') || stage.includes('idea') || stage.includes('validat')) {
    return {
      track: 'BUILD',
      trackAr: 'ابنِ',
      reason: 'You are ready to go from idea to a launched product — the 16-day incubation program fits.',
      reasonAr: 'أنت جاهز للانتقال من الفكرة إلى منتج مُطلق — برنامج الاحتضان (16 يومًا) يناسبك.',
      products: ['build-ticket-incubation-pass'],
    };
  }
  // LEARN — default: read/study/grow.
  return {
    track: 'LEARN',
    trackAr: 'تعلّم',
    reason: 'Start by learning — books and courses build the foundation before you build.',
    reasonAr: 'ابدأ بالتعلّم — الكتب والدورات تبني الأساس قبل أن تبني.',
    products: ['all-men', 'between-one-beat-and-another-arabic'],
  };
}
/* ───────────────────────────────────────────────────────────────────── */

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
  const tasks = app.tasks || [];
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t) => t.status === 'Done').length;
  const percent = totalTasks > 0 ? doneTasks / totalTasks : 0;
  return {
    totalTasks,
    doneTasks,
    percent,
    badges: kvBadges(tasks),
    tasks: tasks.map((t) => ({ name: t.name, status: t.status, channel: t.channel })),
    milestones: [],
    nextTask: tasks.find((t) => t.status !== 'Done')?.name || null,
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

/* ─────────────────────────────────────────────────────────────────────────
 * Airtable mirror — keeps an always-current "Build Candidates" record for
 * every applicant (created at apply time, updated on payment). Best-effort:
 * never throws; only active when AIRTABLE_API_KEY/BASE_ID/TABLE are set.
 * ───────────────────────────────────────────────────────────────────────── */

interface AirtableCandidate {
  fullName: string;
  email: string;
  phone?: string;
  country?: string;
  githubUsername?: string;
  appRef: string;
  tier: string;
  finalPrice: number;
  paymentStatus: string;
  applicationStatus: string;
  track: string;
  notionUrl?: string;
}

async function airtableConfigured(env: Env): Promise<boolean> {
  return !!env.AIRTABLE_API_KEY && !!env.AIRTABLE_BASE_ID && !!env.AIRTABLE_CANDIDATES_TABLE;
}

async function airtableRequest(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.airtable.com/v0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function findAirtableRecord(env: Env, appRef: string): Promise<string | null> {
  if (!(await airtableConfigured(env))) return null;
  try {
    const data = await airtableRequest(
      env,
      'GET',
      `/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_CANDIDATES_TABLE}?filterByFormula=${encodeURIComponent(`{Application Ref}="${appRef}"`)}&maxRecords=1`,
    );
    return data?.records?.[0]?.id || null;
  } catch { return null; }
}

async function syncAirtableCandidate(env: Env, c: AirtableCandidate): Promise<{ ok: boolean; action?: string; recordId?: string; error?: string }> {
  if (!(await airtableConfigured(env))) return { ok: false, error: 'airtable not configured' };
  const now = new Date().toISOString();
  const fields: Record<string, unknown> = {
    'Name': c.fullName || 'Founder',
    'Email': c.email,
    'Phone': c.phone || undefined,
    'Country': c.country || undefined,
    'GitHub Username': c.githubUsername || undefined,
    'Application Ref': c.appRef,
    'Tier': c.tier,
    'Final Price': c.finalPrice,
    'Payment Status': c.paymentStatus,
    'Application Status': c.applicationStatus,
    'Track': c.track,
    'Notion URL': c.notionUrl || undefined,
    'Submitted At': c.paymentStatus === 'Pending' ? now : undefined,
    'Last Updated': now,
  };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;

  const existingId = await findAirtableRecord(env, c.appRef);
  try {
    if (existingId) {
      const res = await airtableRequest(env, 'PATCH', `/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_CANDIDATES_TABLE}`, {
        records: [{ id: existingId, fields: clean }],
      });
      if (res?.records?.[0]) return { ok: true, action: 'updated', recordId: existingId };
      return { ok: false, error: JSON.stringify(res).slice(0, 300) };
    }
    const res = await airtableRequest(env, 'POST', `/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_CANDIDATES_TABLE}`, {
      records: [{ fields: clean }],
    });
    if (res?.records?.[0]) return { ok: true, action: 'created', recordId: res.records[0].id };
    return { ok: false, error: JSON.stringify(res).slice(0, 300) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
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
  if (!(await taskExists(env, candidateId, 'Invite to GitHub repository'))) {
    await createTask(env, { name: 'Invite to GitHub repository', candidateId, dueDays: 0, channel: 'GitHub', automated: true });
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

/**
 * INSTALLMENT PAYMENT handling shared by the webhook AND the reliability
 * sweep. Returns a Response when the order is a *non-final* installment
 * payment (acknowledge without full approval), or `null` to fall through to
 * the full paid-provisioning path (final installment, or no installment
 * marker at all). Without this the sweep would approve a partner after a
 * single partial payment.
 */
async function handleInstallmentPayment(
  env: Env,
  order: any,
  itemProps: any[],
  topProps: any[],
  appRef: string,
): Promise<Response | null> {
  const findRef = (list: any[]) => {
    const attr = list.find((a: any) => a.name === 'application_ref' || a.name === 'applicationRef');
    return attr?.value ?? attr?.application_ref ?? null;
  };
  const instRef = findRef(itemProps) || findRef(topProps) || '';
  const instNoMatch = (() => {
    const all = [...itemProps, ...topProps];
    const m = all.find((a: any) => a.name === 'installment_no');
    return m?.value ? Number(m.value) : NaN;
  })();

  if (!instRef || !appRef || Number.isNaN(instNoMatch)) return null;

  const orderGid = String(order.admin_graphql_api_id || order.id || '');
  const res = await markInstallmentPaid(env, appRef, instNoMatch, orderGid, order.updated_at || new Date().toISOString());
  if (res.ok && res.plan && res.completed) {
    // Final installment → the application becomes fully Paid + Approved and
    // the normal paid-provisioning continues below (fall through).
    return null;
  }
  if (res.ok && res.plan) {
    // Partial payment recorded. Acknowledge — no full approval yet.
    await emitHubEvent(env, {
      type: 'installment.paid',
      source: 'build-apply',
      data: { applicationId: appRef, installmentNo: instNoMatch, email: String(order.email || order.contact_email || '') },
    });
    return jsonResponse({ ok: true, applicationId: appRef, status: `installment ${instNoMatch} paid`, installment: true }, 200, null);
  }
  // If the plan is unknown/errored, fall through to the normal path safely.
  return null;
}

/**
 * Subscription (payment-mandate) webhook events → day-advance. A successful
 * billing attempt unlocks the next curriculum day in D1 and pings Telegram.
 */
async function handleSubscriptionEvent(env: Env, topic: string, payload: any, origin: string | null): Promise<Response> {
  let email = String(
    payload.customer?.email ||
    payload.subscription_contract?.customer?.email ||
    payload.email ||
    ''
  ).toLowerCase().trim();

  // Billing-attempt payloads reference a contract id but not always the email.
  const contractId = String(payload.subscription_contract_id || payload.subscription_contract?.id || '');
  if (!email && contractId) {
    try {
      const g = await shopifyGraphQL(env,
        `query($id: ID!){ subscriptionContract(id: $id) { customer { email } } }`,
        { id: contractId });
      email = String(g?.data?.subscriptionContract?.customer?.email || '').toLowerCase().trim();
    } catch { /* best-effort */ }
  }

  if (!email) {
    return jsonResponse({ ok: false, error: 'no customer email on subscription event' }, 400, origin);
  }

  if (topic.includes('billing_attempts/success')) {
    const r = await advanceStudentDay(env, email, 'subscription_billing');
    return jsonResponse({ ok: true, advanced: r.ok, day: r.day, email }, 200, origin);
  }

  return jsonResponse({ ok: true, acknowledged: true, topic }, 200, origin);
}

async function handleShopifyWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = request.headers.get('origin');
  const body = await request.text();
  const hmac = request.headers.get('x-shopify-hmac-sha256') || '';
  const topic = request.headers.get('x-shopify-topic') || '';
  console.log(`webhook received: topic=${topic} hmac=${hmac.slice(0, 12)}… bodyLen=${body.length}`);

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

  if (topic && topic.startsWith('subscriptions/')) {
    let payload: any;
    try { payload = JSON.parse(body); } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400, origin);
    }
    return handleSubscriptionEvent(env, topic, payload, origin);
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

  // Confirmed live 2026-08-14: Shopify delivers this event to build-apply
  // through more than one route (mirrors the same redundant-subscription
  // pattern found and fixed on app.brainsait.de). Three near-simultaneous
  // deliveries all read "not yet Paid" from Notion before the first one
  // finishes writing, so all three race through milestone seeding,
  // certificate issuance, and GitHub provisioning concurrently -- the
  // Notion-state idempotency check below is real but too slow to catch
  // this. This guard is atomic (KV put with no read-then-write gap) and
  // runs before any slow processing starts, so only the first delivery
  // proceeds; the rest get a clean 200 and stop here.
  const orderKey = String(order.admin_graphql_api_id || order.id || '');
  if (orderKey && env.APPLICATIONS) {
    const dedupKey = `webhook-processed:${orderKey}`;
    if (await env.APPLICATIONS.get(dedupKey)) {
      return jsonResponse({ ok: true, idempotent: true, reason: 'duplicate delivery' }, 200, origin);
    }
    await env.APPLICATIONS.put(dedupKey, new Date().toISOString(), { expirationTtl: 7 * 24 * 60 * 60 });
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

  // INSTALLMENT PAYMENT: if the order carries an installment marker, record
  // that single installment as paid. The application is only fully approved
  // when every installment is settled (final installment falls through to
  // full provisioning below).
  const instRes = await handleInstallmentPayment(env, order, itemProps, topProps, appRef);
  if (instRes) return instRes;

  if (!appRef) {
    // Genuine Shopify order that is not a BUILD ticket (e.g. regular store
    // purchase). Acknowledge, then trigger the post-purchase BUILD upsell.
    ctx.waitUntil(handlePostPurchaseUpsell(env, order));
    return jsonResponse({ ok: true, ignored: true, reason: 'not a BUILD order', upsell: true }, 200, origin);
  }

  return await provisionPaidApplication(env, order, appRef, origin);
}

/**
 * Post-purchase BUILD upsell — when a customer buys a LEARN product (a book
 * or novel), gently invite them to graduate from "reader" to "builder" with
 * the BUILD incubation program. Three coordinated side-effects:
 *   1. log the event into the D1 central state,
 *   2. tag the Shopify customer for segmentation,
 *   3. send a luxury bilingual invitation email.
 * Best-effort throughout — never throws.
 */
async function handlePostPurchaseUpsell(env: Env, order: any): Promise<void> {
  const email = String(order.email || order.contact_email || (order.customer?.email) || '').toLowerCase().trim();
  if (!email) return;
  const titles = (order.line_items || []).map((li: any) => String(li.title || li.name || ''));
  // The BUILD ticket is handled by the main provisioning path — skip it here.
  if (titles.some((t: string) => /BUILD|incubation/i.test(t))) return;
  const firstName = String((order.customer?.first_name) || '').trim();

  // 1. Log to D1 central event state.
  try {
    await env.BUILD_DB.prepare(
      `INSERT INTO events (event_type, student_email, payload, created_at) VALUES (?, ?, ?, ?)`
    ).bind('shopify.post_purchase', email, JSON.stringify({ titles, total: order.total_price }), new Date().toISOString()).run();
  } catch { /* best-effort */ }

  // 2. Tag the Shopify customer for post-purchase segmentation.
  if (order.customer?.id) {
    try {
      const cur = await shopifyRest(env, 'GET', `customers/${order.customer.id}.json`);
      const existing = String(cur.data?.customer?.tags || '');
      const tags = existing ? `${existing}, post-purchase-upsell` : 'post-purchase-upsell';
      await shopifyRest(env, 'PUT', `customers/${order.customer.id}.json`, { customer: { id: order.customer.id, tags } });
    } catch { /* best-effort */ }
  }

  // 3. Send the invitation email.
  if (!env.RESEND_API_KEY) return;
  const name = firstName || 'Founder';
  const body = `
    <p style="margin:0 0 14px;color:#8a6d1f;font-family:Arial,sans-serif;font-size:12px;letter-spacing:.1em;text-transform:uppercase;">أهلًا بك في عائلة برينسايت</p>
    <p style="margin:0 0 16px;font-size:19px;color:#131320;"><b>${escapeHtml(name)}، شكرًا لأنك بدأت بالقراءة 📖</b></p>
    <p style="margin:0 0 16px;color:#555;font-size:15px;line-height:1.8;">القارئ يرى، والباني يملك. أنت اخترت أن تتعلّم — والخطوة الطبيعية التالية أن <b>تبني</b>.</p>
    <p style="margin:0 0 16px;color:#555;font-size:15px;line-height:1.8;">برنامج <b>BUILD</b> يحوّلك من قارئ إلى مؤسّس خلال 16 يومًا: متجرك، منتجك، أتمتتك، وعقلك الثاني — كلّه جاهز للانطلاق.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px auto;"><tr><td style="background:linear-gradient(135deg,#c9a227,#e9c46a);border-radius:999px;padding:14px 34px;">
      <a href="https://fadil369.github.io/build" style="color:#131320;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;">اكتشف BUILD 🚀</a>
    </td></tr></table>
    <p style="margin:0;text-align:center;color:#999;font-size:12px;font-family:Arial,sans-serif;">أو تصفّح المتجر كاملًا: <a href="https://fadil369.github.io" style="color:#8a6d1f;">fadil369.github.io</a></p>
  `;
  const html = luxuryEmailShell('جاهز تبني؟ · Ready to build?', body);
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || RESEND_FROM,
        to: email,
        subject: `✨ ${name} — من قارئ إلى باني | From reader to builder`,
        html,
      }),
    });
  } catch { /* best-effort */ }
}

async function provisionPaidApplication(env: Env, order: any, appRef: string, origin: string | null): Promise<Response> {
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
      githubUsername: app.githubUsername,
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

    // Every step from here is independently best-effort. Confirmed live
    // 2026-08-14: an unprotected createOnboardingPlan() call let a missing
    // Notion connection on ONE sub-database (Build Tasks) throw uncaught
    // and abort the entire handler before milestone seeding, certificate
    // issuance, or GitHub provisioning ever ran -- despite Payment Status
    // having already been marked Paid moments earlier. No single sub-system
    // gets to block the rest of a paid candidate's processing again.
    try { await createOnboardingPlan(env, candidate.id, payload); } catch (err) { console.error(`createOnboardingPlan failed for ${appRef}: ${err}`); }
    // Paid candidates get the full 16-milestone curriculum seeded so the
    // certification system has a real target to track.
    try { await seedMilestones(env, candidate.id); } catch { /* best-effort */ }
    try { await updateProgressOnApplication(env, candidate.id); } catch (err) { console.error(`updateProgressOnApplication failed for ${appRef}: ${err}`); }
  }

  // Certificate may already be issuable (e.g. milestones seeded earlier).
  try { await checkAndIssueCertificate(env, candidate, appRef); } catch { /* best-effort */ }

  // Real, isolated GitHub repo per paid candidate — Phase 1 of the BUILD
  // access model. Uses the GitHub username collected at intake; works for both
  // Notion-backed and KV-backed applications.
  const githubUsername = candidate?.kv
    ? candidate.kv.githubUsername
    : candidate?.properties?.['GitHub Username']?.rich_text?.[0]?.plain_text;
  try {
    console.log(`Webhook call site: candidate.kv=${!!candidate?.kv} githubUsername=${githubUsername || '(none)'}`);
    await provisionGitHubAccess(env, appRef, githubUsername);
  } catch (err) {
    console.error(`provisionGitHubAccess threw: ${err}`);
  }

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
      tags: ['build-partner', 'super-partner', 'paid', 'partner-profile'],
    }, true);
  } catch { /* non-fatal */ }

  if (env.RESEND_API_KEY && payload.email) {
    try {
      await sendPaidWelcomeEmail(env, payload.email, payload.fullName || 'Founder', appRef);
    } catch { /* best-effort */ }
  }

  // Personal Telegram onboarding: private welcome with the Founder OS course,
  // the BUILD 2nd Brain, the GitHub repo and the cohort invite link.
  const telegramId = candidate?.kv
    ? candidate.kv.telegramId
    : candidate?.properties?.['Telegram ID']?.rich_text?.[0]?.plain_text;
  try {
    await sendTelegramWelcome(env, {
      telegramId: telegramId || '',
      fullName: payload.fullName || 'Founder',
      appRef,
      githubUsername: githubUsername || '',
    });
  } catch (err) { console.error(`sendTelegramWelcome failed for ${appRef}: ${err}`); }

  // SUPER PARTNER SUITE: fulfillment record, welcome gift card, B2B company,
  // and analytics annotation — all idempotent + best-effort. Uses the paid
  // order id so the partner's order is marked fulfilled with the onboarding kit.
  let superResults: Record<string, any> = {};
  try {
    const orderId = String(order.admin_graphql_api_id || order.id || '');
    if (orderId && payload.email) {
      const prov = await provisionSuperPartner(env, {
        orderId,
        email: orderEmail || payload.email,
        fullName: payload.fullName || 'Founder',
        appRef,
        phone: payload.phone || '',
      });
      superResults = prov.results || {};
    }
  } catch { /* non-fatal — never blocks the paid confirmation */ }

  // Fan the rich provisioning event onto the ecosystem event bus so the
  // portal, n8n, Hermes, Telegram and the SSE dashboard can react instantly.
  try {
    await emitHubEvent(env, {
      type: 'super.partner.provisioned',
      source: 'build-apply',
      data: {
        applicationId: appRef,
        email: orderEmail || payload.email,
        fullName: payload.fullName || 'Founder',
        tier: 'STANDARD',
        orderId: String(order.admin_graphql_api_id || order.id || ''),
        fulfillmentId: superResults.fulfillment?.fulfillmentId,
        giftCardId: superResults.giftCard?.giftCardId,
        companyId: superResults.company?.companyId,
        githubUsername,
        trackUrl: `${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}`,
        notionUrl: candidate.url || '',
      },
    });
  } catch { /* best-effort */ }

  // Synchronous profile write to the account portal (portal.brainsait.de) so
  // the partner's role + Super entitlements are live immediately.
  try {
    await syncPartnerProfile(env, {
      applicationId: appRef,
      email: orderEmail || payload.email || '',
      fullName: payload.fullName || 'Founder',
      tier: 'STANDARD',
      orderId: String(order.admin_graphql_api_id || order.id || ''),
      fulfillmentId: superResults.fulfillment?.fulfillmentId || '',
      giftCardId: superResults.giftCard?.giftCardId || '',
      companyId: superResults.company?.companyId || '',
      githubUsername: githubUsername || '',
      trackUrl: `${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}`,
      notionUrl: candidate.url || '',
    });
  } catch { /* best-effort */ }

  // Update the candidate's Notion page inside the Second Brain: add the
  // Super Partner badge + provisioning summary so the onboarding board and
  // milestone tracking reflect the entitlements.
  try {
    await syncPartnerToNotion(env, {
      candidateId: candidate?.id,
      appRef,
      fullName: payload.fullName || 'Founder',
      fulfillmentId: superResults.fulfillment?.fulfillmentId,
      giftCardId: superResults.giftCard?.giftCardId,
      companyId: superResults.company?.companyId,
      trackUrl: `${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}`,
      notionUrl: candidate.url || '',
    });
  } catch { /* best-effort */ }

  // Index the partner into the AI-searchable knowledge base (D1) so the AI
  // gateway / RAG and ecosystem agents can find them.
  try {
    await embedPartnerToKb(env, {
      applicationId: appRef,
      email: orderEmail || payload.email || '',
      fullName: payload.fullName || 'Founder',
      tier: 'STANDARD',
      orderId: String(order.admin_graphql_api_id || order.id || ''),
      fulfillmentId: superResults.fulfillment?.fulfillmentId || '',
      giftCardId: superResults.giftCard?.giftCardId || '',
      companyId: superResults.company?.companyId || '',
      githubUsername: githubUsername || '',
      trackUrl: `${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}`,
      notionUrl: candidate.url || '',
    });
  } catch { /* best-effort */ }

  // Airtable mirror: flip the candidate's record to Paid + Approved so the
  // Build Candidates ledger always reflects the live pipeline.
  try {
    await syncAirtableCandidate(env, {
      fullName: payload.fullName || 'Founder',
      email: payload.email || '',
      phone: payload.phone || '',
      country: payload.country || '',
      githubUsername: candidate?.kv
        ? candidate.kv.githubUsername
        : candidate?.properties?.['GitHub Username']?.rich_text?.[0]?.plain_text || '',
      appRef,
      tier: 'STANDARD',
      finalPrice: 9630,
      paymentStatus: 'Paid',
      applicationStatus: 'Approved',
      track: 'Founder Accelerator',
      notionUrl: candidate.url || '',
    });
  } catch { /* non-fatal */ }

  return jsonResponse({ ok: true, applicationId: appRef, status: 'paid & approved' }, 200, origin);
}

async function sendPaidWelcomeEmail(env: Env, email: string, name: string, appRef: string): Promise<void> {
  const trackUrl = `${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}`;
  const body = `
    <p style="margin:0 0 14px;font-size:17px;color:#131320;"><b>🎉 Welcome, ${escapeHtml(name)}</b></p>
    <p style="margin:0 0 16px;">Your payment is confirmed and your seat is <b>approved</b>. You are officially a BrainSAIT partner now — and a very valuable one.</p>
    <p style="margin:0 0 10px;color:#131320;"><b>🎁 Your Second Brain is waiting</b> — the gift we promised to those who use their first brain very well. It is organized, connected, and alive: 15 days, 18 labs, 16 milestones.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:linear-gradient(135deg,#c9a227,#e9c46a);border-radius:999px;padding:14px 34px;">
      <a href="${SECOND_BRAIN_URL}" style="color:#131320;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:15px;">Open your Second Brain 🧠</a>
    </td></tr></table>
    <p style="margin:0 0 10px;color:#131320;"><b>🚀 Your Founder OS incubator course is live</b> — from idea to company, the full founder operating system.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:#131320;border-radius:999px;padding:13px 30px;">
      <a href="${FOUNDER_OS_URL}" style="color:#e9c46a;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;">Start Founder OS →</a>
    </td></tr></table>
    <p style="margin:0 0 10px;color:#131320;"><b>🧠 Your BUILD Ultimate Brain (2nd Brain)</b> — the Arabic incubator edition with your onboarding board, milestones and lab simulators.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:#131320;border-radius:999px;padding:13px 30px;">
      <a href="${ULTIMATE_BRAIN_BUILD_URL}" style="color:#e9c46a;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;">Open your BUILD 2nd Brain →</a>
    </td></tr></table>
    <p style="margin:0 0 10px;color:#131320;"><b>📅 Need a bigger discount or an adjusted plan?</b> <a href="${CALENDAR_URL}" style="color:#8a6d1f;">Book a 1:1 evaluation</a> — 30 minutes with the founder.</p>
    <p style="margin:0 0 10px;color:#131320;"><b>🧑‍💻 Everything is already set up for you</b> — all automated the moment your payment landed:</p>
    <ul style="margin:0 0 16px;padding-left:20px;color:#444;font-family:Arial,sans-serif;font-size:14px;line-height:1.8;">
      <li><b>Notion onboarding</b> — your application page and milestone board are live, all 16 milestones seeded.</li>
      <li><b>GitHub repo</b> — your own repository generated from the BUILD starter, with you added as a collaborator (when a GitHub username was provided at intake).</li>
      <li><b>Customer account</b> — your Shopify customer account (via the Partner API) is tagged as a build partner.</li>
      <li><b>Daily standups</b> — a task is created for you every working day; complete it on your Notion board or from your dashboard.</li>
    </ul>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:#131320;border-radius:999px;padding:13px 30px;">
      <a href="${trackUrl}" style="color:#e9c46a;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;">Open your progress dashboard →</a>
    </td></tr></table>
    <p style="margin:0 0 10px;color:#131320;"><b>📈 Your builder profile</b> — connected to your Shopify customer account at <a href="${ACCOUNT_URL}" style="color:#8a6d1f;">account.brainsait.org</a>. Track your progress, showcase your proof, ship your product.</p>
    <hr style="border:none;border-top:1px solid #e5ddc4;margin:20px 0;" />
    <p style="margin:0;color:#666;font-size:13px;font-family:Arial,sans-serif;">Application <b>${appRef}</b> · Track progress at <a href="${trackUrl}" style="color:#8a6d1f;">${trackUrl}</a></p>
  `;
  const html = luxuryEmailShell('Your BrainSAIT partner seat is active 🎉', body);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || RESEND_FROM,
      to: email,
      subject: '🎉 Your BrainSAIT partner seat is active — Second Brain inside',
      html,
    }),
  });
}

async function sendTelegramWelcome(env: Env, opts: {
  telegramId?: string;
  fullName: string;
  appRef: string;
  githubUsername?: string;
}): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !opts.telegramId) return;
  const trackUrl = `${BUILD_TRACK_URL}?ref=${encodeURIComponent(opts.appRef)}`;
  const repoName = `build-${opts.appRef.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60)}`;
  const lines = [
    `🎉 <b>Welcome, ${escapeHtml(opts.fullName)}</b> — your BUILD seat is ACTIVE!`,
    `✅ Payment confirmed · Super Partner`,
    `🚀 Founder OS course: ${FOUNDER_OS_URL}`,
    `🧠 Your 2nd Brain (BUILD): ${ULTIMATE_BRAIN_BUILD_URL}`,
    opts.githubUsername ? `🐙 Your GitHub repo: ${GITHUB_PROFILE_URL}/${GITHUB_TEMPLATE_OWNER}/${repoName}` : '',
    `📊 Track your 16 milestones: ${trackUrl}`,
    env.TELEGRAM_COHORT_LINK ? `👥 Cohort: ${env.TELEGRAM_COHORT_LINK}` : '',
    `📅 Adjust plan or discount: ${CALENDAR_URL}`,
  ].filter(Boolean).join('\n');
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: opts.telegramId,
      text: lines,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}

async function sweepUnprocessedPaidOrders(env: Env): Promise<void> {
  // Reliability fallback for the orders/paid webhook: scan recent paid orders
  // via the Admin API and provision any BUILD application the webhook hasn't
  // already handled (idempotent via the webhook-processed dedup key). This
  // guarantees enrollment even if a webhook delivery is lost — the cron runs
  // daily (plus on demand via POST /admin/sweep).
  if (!env.SHOPIFY_ADMIN_TOKEN) return;
  try {
    const shop = env.SHOPIFY_STORE_DOMAIN || 'f3rbxp-n1.myshopify.com';
    const resp = await fetch(
      `https://${shop}/admin/api/2026-04/orders.json?status=any&financial_status=paid&limit=50` +
      `&fields=id,admin_graphql_api_id,email,contact_email,line_items,note_attributes,properties,created_at`,
      { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN } },
    );
    if (!resp.ok) { console.error(`sweep: orders fetch HTTP ${resp.status}`); return; }
    const data = (await resp.json()) as { orders?: any[] };
    for (const order of data.orders || []) {
      const gid = String(order.admin_graphql_api_id || order.id || '');
      if (!gid || await env.APPLICATIONS.get(`webhook-processed:${gid}`)) continue;
      const attrs = order.note_attributes || [];
      const itemProps = (order.line_items || []).flatMap((li: any) => li.properties || []);
      const findRef = (list: any[]) => {
        const a = list.find((x: any) => x.name === 'application_ref' || x.name === 'applicationRef');
        return a?.value ?? null;
      };
      const appRef = findRef(attrs) || findRef(itemProps) || findRef(order.properties || []);
      if (!appRef) continue;
      // Installment partial payments must NOT trigger full approval — mirror
      // the webhook's installment handling so a */15 sweep can't approve a
      // partner after a single partial payment.
      try {
        const instRes = await handleInstallmentPayment(env, order, itemProps, order.properties || [], appRef);
        if (instRes) {
          console.log(`sweep: order ${gid} appRef=${appRef} installment handled (HTTP ${instRes.status})`);
          await env.APPLICATIONS.put(`webhook-processed:${gid}`, '1', { expirationTtl: 60 * 60 * 24 * 90 });
          continue;
        }
      } catch (err) {
        console.error(`sweep: installment check failed for ${gid}: ${err}`);
      }
      try {
        const res = await provisionPaidApplication(env, order, appRef, null);
        console.log(`sweep: order ${gid} appRef=${appRef} → HTTP ${res.status}`);
        if (res.status === 200) {
          await env.APPLICATIONS.put(`webhook-processed:${gid}`, '1', { expirationTtl: 60 * 60 * 24 * 90 });
        }
      } catch (err) {
        console.error(`sweep: order ${gid} failed: ${err}`);
      }
    }
  } catch (err) {
    console.error(`sweepUnprocessedPaidOrders failed: ${err}`);
  }
}

async function handleCron(_event: ScheduledEvent, env: Env): Promise<void> {
  // Reliability sweep: provisions any paid BUILD order the webhook missed.
  try {
    await sweepUnprocessedPaidOrders(env);
  } catch { /* best-effort */ }

  // INSTALLMENT SWEEP runs daily regardless of Notion config — it tracks
  // payment schedules, escalates reminders, and suspends overdue partners.
  try {
    const sweep = await runInstallmentSweep(env);
    if (sweep.reminded || sweep.suspended) {
      await emitHubEvent(env, {
        type: 'installment.sweep',
        source: 'build-apply',
        data: sweep,
      });
    }
  } catch { /* best-effort */ }

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
      const appRef = props['Payment Reference']?.rich_text?.[0]?.plain_text;
      // Determine the partner's current curriculum day from completed milestones,
      // then send that day's "newsletter" (theory + lab + deliverable + tools).
      let curriculumDay = 0;
      try {
        const p = await calculateProgress(env, id);
        curriculumDay = Math.max(0, Math.min(15, p.milestones.filter((m) => m.status === 'Completed').length));
      } catch { /* default day 0 */ }
      await sendDailyCurriculumEmail(env, email, name, curriculumDay, appRef || '');
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
  // Each sub-database query is independently best-effort: a permissions gap
  // or outage on Tasks shouldn't take down Milestones (or the whole request)
  // and vice versa. Missing data degrades to zero progress, not a 500.
  let tasksData: any = { results: [] };
  if (env.NOTION_TASKS_DB_ID) {
    try {
      tasksData = await notionRequest(env, 'POST', `/databases/${env.NOTION_TASKS_DB_ID}/query`, {
        filter: { property: 'Candidate', relation: { contains: candidateId } },
      });
    } catch (err) {
      console.error(`calculateProgress: Tasks query failed for ${candidateId}: ${err}`);
    }
  }

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
    try {
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
    } catch (err) {
      console.error(`calculateProgress: Milestones query failed for ${candidateId}: ${err}`);
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
  const pdfUrl = `${BUILD_CERT_BASE}/certificate/${encodeURIComponent(appRef)}/pdf`;
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
    <div style="position:absolute;bottom:26px;left:50%;transform:translateX(-50%);"><a href="${pdfUrl}" style="display:inline-block;background:#131320;color:#e9c46a;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:12px;border-radius:999px;padding:9px 22px;">⬇ Download PDF</a></div>
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
<p>Track your progress and milestones on your dashboard and Notion board. Keep shipping.</p></div></body></html>`;
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
    <p style="margin:0 0 10px;color:#131320;"><b>🧑‍💻 Keep shipping</b> — your GitHub repo and Notion board stay with you for good; milestones and progress remain tracked in your dashboard.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:#131320;border-radius:999px;padding:13px 30px;">
      <a href="${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}" style="color:#e9c46a;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;">Open your dashboard →</a>
    </td></tr></table>
    <p style="margin:18px 0 0;color:#666;font-size:13px;font-family:Arial,sans-serif;">You are now a BrainSAIT <b>partner</b>. Your builder profile lives at <a href="${ACCOUNT_URL}" style="color:#8a6d1f;">account.brainsait.org</a> — track progress, share your story, sell what you built.</p>
  `;
  const html = luxuryEmailShell(`Your BrainSAIT Completion Certificate — ${certCode}`, body);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || RESEND_FROM,
      to: email,
      subject: `🎓 Your BrainSAIT Completion Certificate — ${certCode}`,
      html,
    }),
  });
}

/** The BUILD partner "newsletter" — one curriculum email per program day. */
async function sendDailyCurriculumEmail(env: Env, email: string, name: string, day: number, appRef: string): Promise<void> {
  if (!env.RESEND_API_KEY || !email) return;
  const c = curriculumForDay(day) || BUILD_CURRICULUM[0];
  const stack = c.stack.map((s) => `<span style="background:#f3edda;border-radius:999px;padding:3px 10px;font-family:Arial,sans-serif;font-size:11px;color:#8a6d1f;margin:0 4px 4px 0;display:inline-block;">${escapeHtml(s)}</span>`).join('');
  const body = `
    <p style="margin:0 0 8px;color:#8a6d1f;font-family:Arial,sans-serif;font-size:12px;letter-spacing:.08em;text-transform:uppercase;">Day ${c.day} / 14</p>
    <p style="margin:0 0 16px;font-size:20px;color:#131320;"><b>${c.emoji} ${escapeHtml(c.title)}</b></p>
    <p style="margin:0 0 18px;color:#555;font-size:15px;line-height:1.75;">${escapeHtml(c.theory)}</p>
    <p style="margin:0 0 6px;color:#131320;font-weight:700;">🧪 مختبر اليوم</p>
    <p style="margin:0 0 18px;color:#555;font-size:15px;line-height:1.75;">${escapeHtml(c.lab)}</p>
    <p style="margin:0 0 6px;color:#131320;font-weight:700;">✅ التسليم المطلوب</p>
    <p style="margin:0 0 18px;color:#555;font-size:15px;line-height:1.75;">${escapeHtml(c.deliverable)}</p>
    <p style="margin:0 0 8px;color:#131320;font-weight:700;">🛠️ أدوات اليوم (سرّ المنظومة)</p>
    <p style="margin:0 0 20px;">${stack}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px auto;"><tr><td style="background:linear-gradient(135deg,#c9a227,#e9c46a);border-radius:999px;padding:13px 30px;">
      <a href="${SECOND_BRAIN_URL}" style="color:#131320;text-decoration:none;font-weight:700;font-family:Arial,sans-serif;font-size:14px;">افتح دماغك الثاني 🧠</a>
    </td></tr></table>
    <p style="margin:0 0 8px;text-align:center;color:#666;font-size:13px;font-family:Arial,sans-serif;">لوحة التقدم: <a href="${BUILD_TRACK_URL}?ref=${encodeURIComponent(appRef)}" style="color:#8a6d1f;">تتبّع معالمك</a></p>
  `;
  const html = luxuryEmailShell(`يوم ${c.day} · ${c.title}`, body);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || RESEND_FROM,
      to: email,
      subject: `🧠 يوم ${c.day} · ${c.title}`,
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
    let repoUrl: string | undefined;
    try {
      const rec = (await env.APPLICATIONS.get(`github-provisioned:${applicationRef}`, 'json')) as { repoUrl?: string } | null;
      repoUrl = rec?.repoUrl;
    } catch { /* ignore */ }
    const planStatus = await planStatusForRef(env, applicationRef);
    const capabilities = computeAccessCapabilities(app.paymentStatus, planStatus);
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
      repoUrl: planStatus === 'SUSPENDED' ? undefined : repoUrl,
      capabilities,
      ...progress,
    }, 200, origin);
  }
  const progress = await calculateProgress(env, candidate.id);
  const props = candidate.properties;

  // The candidate's provisioned GitHub repo (generated after payment from the
  // BUILD starter) is surfaced here so the Track page can link it directly.
  let repoUrl: string | undefined;
  try {
    const rec = (await env.APPLICATIONS.get(`github-provisioned:${applicationRef}`, 'json')) as { repoUrl?: string } | null;
    repoUrl = rec?.repoUrl;
  } catch { /* ignore */ }

  // Automated certification: when every milestone is Completed, the
  // certificate is issued once (idempotent) and the luxury email goes out.
  try {
    await checkAndIssueCertificate(env, candidate, applicationRef);
  } catch { /* best-effort — progress still returns */ }

  const planStatus = await planStatusForRef(env, applicationRef);
  const capabilities = computeAccessCapabilities(props['Payment Status']?.select?.name, planStatus);

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
    repoUrl: planStatus === 'SUSPENDED' ? undefined : repoUrl,
    capabilities,
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

async function certificateInfoForRef(env: Env, applicationRef: string) {
  const candidate = await findApplicationByRef(env, applicationRef);
  if (!candidate) return null;
  const name = candidate.kv
    ? candidate.kv.fullName
    : candidate.properties.Name?.title?.[0]?.plain_text || 'Builder';
  const trackName = candidate.kv
    ? candidate.kv.trackName
    : candidate.properties['Founder OS Track']?.select?.name || 'Founder Accelerator';
  let record: any = null;
  try { record = await env.APPLICATIONS.get(CERT_KEY(applicationRef), 'json'); } catch { /* ignore */ }
  if (!record?.issued) {
    // Issue if fully complete, otherwise return "not ready".
    await checkAndIssueCertificate(env, candidate, applicationRef);
    try { record = await env.APPLICATIONS.get(CERT_KEY(applicationRef), 'json'); } catch { /* ignore */ }
  }
  if (!record?.issued) return { name, trackName, issued: false as const };
  return {
    name,
    trackName,
    issued: true as const,
    code: record.code,
    issuedAt: record.issuedAt || new Date().toISOString(),
  };
}

async function handleCertificatePdf(request: Request, env: Env, applicationRef: string): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!applicationRef || applicationRef.length < 8) {
    return jsonResponse({ ok: false, error: 'Invalid application ref' }, 400, origin);
  }
  const info = await certificateInfoForRef(env, applicationRef);
  if (!info) return jsonResponse({ ok: false, error: 'Application not found' }, 404, origin);
  if (!info.issued) return jsonResponse({ ok: false, error: 'Certificate not issued yet — complete all milestones' }, 409, origin);

  const pdf = await generateCertificatePdf({
    name: info.name,
    code: info.code,
    appRef: applicationRef,
    track: info.trackName,
    issuedAt: info.issuedAt,
  });

  return new Response(pdf as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="BrainSAIT-Certificate-${info.code}.pdf"`,
      'Cache-Control': 'public, max-age=300',
      ...corsHeaders(origin),
    },
  });
}

async function handleCertificateSign(request: Request, env: Env, applicationRef: string): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!applicationRef || applicationRef.length < 8) {
    return jsonResponse({ ok: false, error: 'Invalid application ref' }, 400, origin);
  }
  const info = await certificateInfoForRef(env, applicationRef);
  if (!info) return jsonResponse({ ok: false, error: 'Application not found' }, 404, origin);
  if (!info.issued) return jsonResponse({ ok: false, error: 'Certificate not issued yet — complete all milestones' }, 409, origin);

  const pdf = await generateCertificatePdf({
    name: info.name,
    code: info.code,
    appRef: applicationRef,
    track: info.trackName,
    issuedAt: info.issuedAt,
  });

  const result = await signCertificateWithAdobe(
    {
      integrationKey: env.ADOBE_SIGN_INTEGRATION_KEY,
      clientSecret: env.ADOBE_SIGN_CLIENT_SECRET,
      apiBase: env.ADOBE_SIGN_BASE,
      signerEmail: env.ADOBE_SIGN_SIGNER_EMAIL,
    },
    pdf,
    { name: info.name, code: info.code },
  );

  return jsonResponse(result, result.ok ? 200 : 502, origin);
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

/** Derive the candidate's current curriculum day (0–15) from completed milestones. */
async function currentDayForCandidate(env: Env, candidate: { id: string; properties: any; kv?: KvApplication }): Promise<number> {
  if (candidate.kv) return 0; // KV path has no milestones; caller supplies an explicit day.
  const milestones = await milestonesForCandidate(env, candidate.id);
  const done = milestones.filter((m) => m.status === 'Completed').length;
  return Math.max(0, Math.min(15, done));
}

async function handleBotGuide(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const body = (await request.json().catch(() => ({}))) as { telegram_id?: string; day?: number };
  if (!body.telegram_id) return jsonResponse({ ok: false, error: 'Missing telegram_id' }, 400, origin);
  const candidate = await findApplicationByTelegram(env, body.telegram_id);
  if (!candidate) return jsonResponse({ ok: false, error: 'No application linked. Use /link <ref> first.' }, 404, origin);

  const day = Math.max(0, Math.min(15, typeof body.day === 'number' ? body.day : await currentDayForCandidate(env, candidate)));
  const c = curriculumForDay(day) || BUILD_CURRICULUM[0];
  const message = [
    `${c.emoji} اليوم ${c.day} — ${c.title}`,
    `${c.theme}`,
    ``,
    `📖 النظرية:`,
    c.theory,
    ``,
    `🧪 المختبر العملي:`,
    c.lab,
    ``,
    `✅ المطلوب اليوم:`,
    c.deliverable,
    ``,
    `🛠️ الأدوات (سرّ المنظومة):`,
    c.stack.join(' · '),
    ``,
    `أرسل /test لاختبار فهمك، و/day لتسجيل إنجاز اليوم.`,
  ].join('\n');

  return jsonResponse({ ok: true, day, title: c.title, stack: c.stack, message }, 200, origin);
}

async function handleBotTest(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const body = (await request.json().catch(() => ({}))) as { telegram_id?: string; day?: number };
  if (!body.telegram_id) return jsonResponse({ ok: false, error: 'Missing telegram_id' }, 400, origin);
  const candidate = await findApplicationByTelegram(env, body.telegram_id);
  if (!candidate) return jsonResponse({ ok: false, error: 'No application linked. Use /link <ref> first.' }, 404, origin);

  const day = Math.max(0, Math.min(15, typeof body.day === 'number' ? body.day : await currentDayForCandidate(env, candidate)));
  const c = curriculumForDay(day) || BUILD_CURRICULUM[0];
  const message = [
    `${c.emoji} اختبار اليوم ${c.day}:`,
    c.quiz.q,
    ``,
    ...c.quiz.options.map((o, i) => `${i + 1}) ${o}`),
    ``,
    `أجب عبر /answer ${c.day} <رقم الخيار>`,
  ].join('\n');

  return jsonResponse({ ok: true, day, quiz: c.quiz, message }, 200, origin);
}

async function handleBotAnswer(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const body = (await request.json().catch(() => ({}))) as { telegram_id?: string; day?: number; option?: number };
  if (!body.telegram_id) return jsonResponse({ ok: false, error: 'Missing telegram_id' }, 400, origin);
  const candidate = await findApplicationByTelegram(env, body.telegram_id);
  if (!candidate) return jsonResponse({ ok: false, error: 'No application linked.' }, 404, origin);

  const day = Math.max(0, Math.min(15, typeof body.day === 'number' ? body.day : await currentDayForCandidate(env, candidate)));
  const c = curriculumForDay(day) || BUILD_CURRICULUM[0];
  const chosen = typeof body.option === 'number' ? body.option - 1 : -1;
  const correct = chosen === c.quiz.answer;
  const message = [
    correct ? `✅ إجابة صحيحة! أحسنت — أنت تبني فعلاً.` : `❌ ليست الإجابة الصحيحة. الخيار الصحيح: ${c.quiz.answer + 1}) ${c.quiz.options[c.quiz.answer]}`,
    ``,
    `💡 ${c.quiz.explain}`,
    ``,
    `واصل — أرسل /day لتسجيل إنجاز اليوم التالي، أو /guide لليوم القادم.`,
  ].join('\n');

  return jsonResponse({ ok: true, correct, message }, 200, origin);
}

async function handleAdminStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  const token = request.headers.get('x-admin-token') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401, origin);
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
    count(app.applicationStatus || 'Unknown', app.trackName || 'None', kvProgress(app).badges, kvProgress(app).percent * 100);
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

/**
 * "Commerce Pulse" — live unified dashboard joining Shopify (orders +
 * Subscriptions API + payment mandates) with the BUILD program's central D1
 * state. Powered by the newly-granted read_all_orders + subscriptions scopes.
 */
async function handleAdminCommerce(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('x-admin-token') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  // ── 1. Shopify orders (read_all_orders scope) ──
  let orders: any[] = [];
  try {
    const r = await shopifyRest(env, 'GET', 'orders.json?status=any&limit=50');
    orders = (r.data?.orders || []) as any[];
  } catch { /* best-effort */ }

  // ── 2. Shopify subscriptions (Subscriptions API scope) ──
  let subscriptions: any[] = [];
  try {
    const g = await shopifyGraphQL(env,
      `{ subscriptionContracts(first: 30) { edges { node { id status createdAt customer { email firstName lastName } } } } }`,
      {});
    subscriptions = (g?.data?.subscriptionContracts?.edges || []).map((e: any) => e.node);
  } catch { /* best-effort */ }

  // ── 3. BUILD students (D1 central state) ──
  const students = new Map<string, Record<string, unknown>>();
  try {
    const rows = await env.BUILD_DB.prepare(`SELECT * FROM students ORDER BY updated_at DESC LIMIT 200`).all();
    for (const s of (rows as any).results || []) students.set(String(s.email).toLowerCase(), s);
  } catch { /* best-effort */ }

  // ── 4. Aggregate KPIs ──
  const paid = orders.filter((o) => o.financial_status === 'paid');
  const revenue = paid.reduce((sum: number, o: any) => sum + Number(o.total_price || 0), 0);
  const activeSubs = subscriptions.filter((s) => s.status === 'ACTIVE');
  const subsMrr = activeSubs.length;

  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

  // ── Order rows (joined with BUILD students) ──
  const orderRows = orders.map((o) => {
    const email = String(o.email || (o.customer?.email) || '').toLowerCase();
    const stu = students.get(email);
    const items = (o.line_items || []).map((li: any) => li.title).join(', ');
    const prog = stu ? `Day ${stu.current_day ?? 0} · ${esc(stu.status || 'pending')}` : '—';
    const badge = stu ? '<span class="chip chip-yes">BUILD</span>' : '<span class="chip">visitor</span>';
    return `<tr>
      <td class="mono">${esc(o.name)}</td>
      <td>${esc(email || '?')}</td>
      <td class="dim">${esc(items || '—')}</td>
      <td class="num">${Number(o.total_price || 0).toFixed(0)} SAR</td>
      <td>${o.financial_status === 'paid' ? '<span class="chip chip-paid">paid</span>' : `<span class="chip">${esc(o.financial_status)}</span>`}</td>
      <td>${badge} ${prog}</td>
    </tr>`;
  }).join('');

  const subRows = subscriptions.map((s) => {
    const email = String(s.customer?.email || '').toLowerCase();
    const stu = students.get(email);
    const cls = s.status === 'ACTIVE' ? 'chip-paid' : s.status === 'CANCELLED' ? '' : 'chip-yes';
    return `<tr>
      <td class="mono">${esc(String(s.id).split('/').pop())}</td>
      <td>${esc(email || '?')}</td>
      <td>${esc(s.createdAt?.slice(0, 10) || '—')}</td>
      <td><span class="chip ${cls}">${esc(s.status)}</span></td>
      <td>${stu ? `Day ${stu.current_day ?? 0}` : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="dim" style="text-align:center">No subscriptions yet</td></tr>';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BrainSAIT — Commerce Pulse</title>
<meta http-equiv="refresh" content="30">
<style>
  :root{--bg:#070b14;--panel:#0f1626;--line:rgba(255,255,255,.08);--text:#eef1f6;--muted:#8b94a7;--gold:#e9c46a;--gold2:#c9a227;--cyan:#29d8ff;--ok:#3ecf8e;--rose:#fb7185;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;background:radial-gradient(ellipse at top,#0c1322,#070b14 60%);color:var(--text);min-height:100vh;padding:2rem 1.2rem}
  .wrap{max-width:1100px;margin:0 auto}
  .head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;margin-bottom:1.6rem}
  .head h1{font-size:1.6rem;font-weight:800;letter-spacing:-.02em}
  .head h1 span{background:linear-gradient(100deg,var(--gold),var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent}
  .ts{color:var(--muted);font-size:.8rem}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.6rem}
  .kpi{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:1.2rem;position:relative;overflow:hidden}
  .kpi::before{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(201,162,39,.08),transparent 60%)}
  .kpi .l{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.12em}
  .kpi .v{font-size:1.9rem;font-weight:800;margin-top:.3rem}
  .kpi .v.g{color:var(--gold)}
  .kpi .v.c{color:var(--cyan)}
  .kpi .v.o{color:var(--ok)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:1.3rem;margin-bottom:1.4rem;overflow-x:auto}
  .card h2{font-size:1rem;font-weight:700;margin-bottom:1rem;display:flex;align-items:center;gap:.5rem}
  .card h2::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--gold2);box-shadow:0 0 10px var(--gold2)}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;color:var(--muted);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;padding:.5rem .6rem;border-bottom:1px solid var(--line)}
  td{padding:.6rem;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
  .mono{font-family:'SF Mono',monospace;font-size:.8rem}
  .num{text-align:right;font-weight:700}
  .dim{color:var(--muted)}
  .chip{display:inline-block;font-size:.66rem;font-weight:700;padding:.2rem .55rem;border-radius:999px;background:rgba(255,255,255,.06);color:var(--muted);border:1px solid var(--line)}
  .chip-paid{background:rgba(62,207,142,.14);color:var(--ok);border-color:rgba(62,207,142,.3)}
  .chip-yes{background:rgba(233,196,106,.14);color:var(--gold);border-color:rgba(233,196,106,.3)}
</style></head><body><div class="wrap">
  <div class="head">
    <h1>BrainSAIT <span>Commerce Pulse</span></h1>
    <div class="ts">Live · Shopify ⇄ D1 · ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC</div>
  </div>
  <div class="kpis">
    <div class="kpi"><div class="l">Total Revenue (paid)</div><div class="v g">${revenue.toLocaleString()} <small style="font-size:.8rem">SAR</small></div></div>
    <div class="kpi"><div class="l">Orders</div><div class="v">${orders.length}</div></div>
    <div class="kpi"><div class="l">Active Subscriptions</div><div class="v c">${subsMrr}</div></div>
    <div class="kpi"><div class="l">BUILD Students (D1)</div><div class="v o">${students.size}</div></div>
  </div>
  <div class="card">
    <h2>Recent Orders · joined with BUILD progress</h2>
    <table><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>BUILD</th></tr></thead>
    <tbody>${orderRows || '<tr><td colspan="6" class="dim" style="text-align:center">No orders</td></tr>'}</tbody></table>
  </div>
  <div class="card">
    <h2>Subscriptions · payment mandates</h2>
    <table><thead><tr><th>Contract</th><th>Customer</th><th>Created</th><th>Status</th><th>BUILD Day</th></tr></thead>
    <tbody>${subRows}</tbody></table>
  </div>
</div></body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const SHOPIFY_SHOP_DOMAIN = 'brainsait.myshopify.com';
const SHOPIFY_API_VERSION = '2025-10';

/** Best-effort Shopify REST helper (used for legacy REST endpoints). */
async function shopifyRest(env: Env, method: string, path: string, body?: unknown): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const res = await fetch(
      `https://${env.SHOPIFY_STORE_DOMAIN || SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${path.replace(/^\//, '')}`,
      {
        method,
        headers: {
          'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN || '',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) return { ok: false, error: `${path}: HTTP ${res.status} ${text.slice(0, 200)}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

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

    const res = await shopifyGraphQL(env, `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`, {
      input: {
        email: input.email,
        firstName,
        lastName,
        phone: input.phone || null,
        tags: Array.from(tags).join(', '),
        ...consent,
      },
    });
    const errs = res?.errors || res?.data?.customerCreate?.userErrors || [];
    if (errs.length > 0) return { ok: false, error: errs.map((e: any) => e.message).join('; ') };
    const customerId = res?.data?.customerCreate?.customer?.id;
    if (sendEmailInvite && customerId) {
      // `sendEmailInvite` was removed from customerCreate in current API
      // versions; the account invite is now its own dedicated mutation.
      const inviteRes = await shopifyGraphQL(env, `mutation($id: ID!) { customerSendAccountInviteEmail(customerId: $id) { customer { id } userErrors { field message } } }`, { id: customerId });
      const inviteErrs = inviteRes?.errors || inviteRes?.data?.customerSendAccountInviteEmail?.userErrors || [];
      if (inviteErrs.length > 0) return { ok: false, error: inviteErrs.map((e: any) => e.message).join('; ') };
    }
    return { ok: true, customerId, action: 'created' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
 * SUPER PARTNER SUITE — BrainSAIT OS expanded Admin API capabilities.
 *
 * These best-effort helpers turn a paid BUILD candidate into a fully
 * provisioned partner: fulfillment record on their order, a welcome gift
 * card, a Shopify Company (B2B), a partner-provisioned note on the order,
 * and idempotent ordering. Every function returns quietly on failure so the
 * rest of the pipeline is never blocked.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Issue a welcome gift card to a paid partner (best-effort, idempotent via KV). */
async function issueWelcomeGiftCard(env: Env, input: { email: string; appRef: string; name?: string }): Promise<{ ok: boolean; giftCardId?: string; idempotent?: boolean; error?: string }> {
  if (!env.SHOPIFY_ADMIN_TOKEN) return { ok: false, error: 'no admin token' };
  const dedupKey = `giftcard:${input.appRef}`;
  try {
    if (await env.APPLICATIONS.get(dedupKey)) return { ok: true, idempotent: true };
  } catch { /* best-effort */ }

  // The BUILD partner bonus: SAR 500 store credit as a welcome gift.
  const amount = '500.00';
  try {
    const res = await shopifyGraphQL(env, `mutation($input: GiftCardCreateInput!) {
      giftCardCreate(input: $input) { giftCard { id } userErrors { field message } }
    }`, {
      input: {
        initialValue: amount,
        customerId: null,
        note: `BUILD partner welcome gift — ${input.appRef}`,
        expiresOn: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      },
    });
    const errs = res?.errors || res?.data?.giftCardCreate?.userErrors || [];
    if (errs.length > 0) return { ok: false, error: errs.map((e: any) => e.message).join('; ') };
    const id = res?.data?.giftCardCreate?.giftCard?.id;
    if (id) {
      try { await env.APPLICATIONS.put(dedupKey, id, { expirationTtl: 400 * 24 * 60 * 60 }); } catch { /* best-effort */ }
      return { ok: true, giftCardId: id };
    }
    return { ok: false, error: 'no gift card id returned' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Create a B2B Shopify Company for a paid partner (best-effort). */
async function createPartnerCompany(env: Env, input: { email: string; fullName?: string; appRef: string }): Promise<{ ok: boolean; companyId?: string; error?: string }> {
  if (!env.SHOPIFY_ADMIN_TOKEN) return { ok: false, error: 'no admin token' };
  try {
    const name = input.fullName?.trim() ? `${input.fullName.trim()} — BrainSAIT Partner` : 'BrainSAIT Partner';
    const res = await shopifyGraphQL(env, `mutation($input: CompanyCreateInput!) {
      companyCreate(input: $input) { company { id } userErrors { field message } }
    }`, {
      input: {
        company: {
          name,
          externalId: input.appRef,
          note: `BUILD partner (${input.appRef}) — customer account ${input.email}`,
        },
        companyContact: {
          email: input.email,
        },
      },
    });
    const errs = res?.errors || res?.data?.companyCreate?.userErrors || [];
    if (errs.length > 0) return { ok: false, error: errs.map((e: any) => e.message).join('; ') };
    const id = res?.data?.companyCreate?.company?.id;
    return id ? { ok: true, companyId: id } : { ok: false, error: 'no company id' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Create a fulfillment record on the paid BUILD order so the partner's order
 * shows as fulfilled (the "BUILD onboarding kit" is the deliverable). Uses the
 * store's first location. Idempotent per order.
 */
async function createBuildFulfillment(env: Env, input: { orderId: string; appRef: string; email?: string }): Promise<{ ok: boolean; fulfillmentId?: string; idempotent?: boolean; error?: string }> {
  if (!env.SHOPIFY_ADMIN_TOKEN) return { ok: false, error: 'no admin token' };
  const dedupKey = `fulfillment:${input.appRef}`;
  try {
    if (await env.APPLICATIONS.get(dedupKey)) return { ok: true, idempotent: true };
  } catch { /* best-effort */ }

  try {
    const locRes = await shopifyGraphQL(env, `{ locations(first: 1) { edges { node { id } } } }`, {});
    const locationId = locRes?.data?.locations?.edges?.[0]?.node?.id;
    if (!locationId) return { ok: false, error: 'no location' };

    // Get the line items on this order so we can fulfill them.
    const o = await shopifyGraphQL(env, `query($id: ID!) { order(id: $id) { id lineItems(first: 50) { edges { node { id quantity } } } } }`, { id: input.orderId });
    const items = o?.data?.order?.lineItems?.edges?.map((e: any) => ({ id: e.node.id, quantity: e.node.quantity })) || [];

    const res = await shopifyGraphQL(env, `mutation($orderId: ID!, $lineItems: [FulfillmentOrderLineItemInput!]!, $locationId: ID!, $notify: Boolean!) {
      fulfillmentCreateV2(fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: $orderId, fulfillmentOrderLineItems: $lineItems }], trackingInfo: { company: "BrainSAIT", number: "BUILD-${input.appRef.slice(0, 8).toUpperCase()}" }, notifyCustomer: $notify, locationId: $locationId }) {
        fulfillment { id }
        userErrors { field message }
      }
    }`, {
      orderId: input.orderId,
      lineItems: items,
      locationId,
      notify: false,
    });
    const errs = res?.errors || res?.data?.fulfillmentCreateV2?.userErrors || [];
    if (errs.length > 0) return { ok: false, error: errs.map((e: any) => e.message).join('; ') };
    const id = res?.data?.fulfillmentCreateV2?.fulfillment?.id;
    if (id) {
      try { await env.APPLICATIONS.put(dedupKey, id, { expirationTtl: 400 * 24 * 60 * 60 }); } catch { /* best-effort */ }
      return { ok: true, fulfillmentId: id };
    }
    return { ok: false, error: 'no fulfillment id' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Tag the paid order as a BUILD partner order and append a provisioning note
 * so the store timeline records the Super-partner activation. Best-effort.
 */
async function annotateBuildOrder(env: Env, input: { orderId: string; appRef: string; companyId?: string; giftCardId?: string }): Promise<{ ok: boolean; error?: string }> {
  if (!env.SHOPIFY_ADMIN_TOKEN) return { ok: false, error: 'no admin token' };
  try {
    const parts = ['Super-partner provisioning complete', `application_ref: ${input.appRef}`];
    if (input.companyId) parts.push(`company: ${input.companyId}`);
    if (input.giftCardId) parts.push(`gift_card: ${input.giftCardId}`);
    const res = await shopifyGraphQL(env, `mutation($id: ID!, $tags: [String!]!, $note: String!) {
      orderUpdate(input: { id: $id, tags: $tags, note: $note }) { order { id } userErrors { field message } }
    }`, {
      id: input.orderId,
      tags: ['build-partner', 'super-provisioned'],
      note: parts.join(' · '),
    });
    const errs = res?.errors || res?.data?.orderUpdate?.userErrors || [];
    if (errs.length > 0) return { ok: false, error: errs.map((e: any) => e.message).join('; ') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Orchestrate the full "Super" partner provisioning for a paid BUILD order.
 * Everything is independently best-effort — no single failure blocks the rest.
 */
async function provisionSuperPartner(env: Env, input: { orderId: string; email: string; fullName?: string; appRef: string; phone?: string }): Promise<{ ok: boolean; results: Record<string, any> }> {
  const results: Record<string, any> = {};

  // 1. Fulfillment record on the paid order.
  results.fulfillment = await createBuildFulfillment(env, { orderId: input.orderId, appRef: input.appRef, email: input.email });

  // 2. Welcome gift card (SAR 500 store credit).
  results.giftCard = await issueWelcomeGiftCard(env, { email: input.email, appRef: input.appRef, name: input.fullName });

  // 3. B2B company record for the partner.
  results.company = await createPartnerCompany(env, { email: input.email, fullName: input.fullName, appRef: input.appRef });

  // 4. Tag the order + note the provisioning so the store timeline records it.
  results.annotation = await annotateBuildOrder(env, {
    orderId: input.orderId,
    appRef: input.appRef,
    companyId: results.company?.companyId,
    giftCardId: results.giftCard?.giftCardId,
  });

  const ok = Object.values(results).every((r) => r?.ok === true || r?.idempotent === true);
  return { ok, results };
}

/**
 * Push the partner provisioning into the account portal so the partner's
 * profile at portal.brainsait.de is promoted to the partner role with all
 * Super entitlements (fulfillment, gift card, company, GitHub, Notion).
 * Best-effort — the event bus remains the primary fan-out; this is the
 * synchronous profile write.
 */
async function syncPartnerProfile(env: Env, input: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  try {
    const portal = 'https://portal.brainsait.de/api/integration/super-partner';
    const res = await fetch(portal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok !== true) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Index a newly provisioned partner into the AI-searchable knowledge base
 * (D1 via the MCP hub's kb_embed) and mirror the record into the same D1
 * store as a structured partner row for the AI gateway / RAG to query.
 * Best-effort — never blocks the paid confirmation.
 */
async function embedPartnerToKb(env: Env, input: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  try {
    const hubBase = 'https://hub.brainsait.org';
    const payload = {
      document_id: `partner:${input.applicationId}`,
      text: [
        `BrainSAIT SUPER partner provisioned`,
        `Name: ${input.fullName}`,
        `Email: ${input.email}`,
        `Tier: ${input.tier || 'STANDARD'}`,
        `Application: ${input.applicationId}`,
        `Order: ${input.orderId}`,
        `Fulfillment: ${input.fulfillmentId}`,
        `Gift card: ${input.giftCardId}`,
        `Company: ${input.companyId}`,
        `GitHub: ${input.githubUsername}`,
        `Track: ${input.trackUrl}`,
        `Notion: ${input.notionUrl}`,
      ].join('\n'),
      metadata: {
        source: 'build-apply',
        category: 'partner',
        relevance_score: 0.9,
        language: 'en',
        tags: ['super', 'partner', 'build', input.applicationId],
      },
    };
    const res = await fetch(`${hubBase}/mcp/v1/kb/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Key': env.MCP_HUB_KEY || env.HUB_KEY || '' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `kb embed HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Update the candidate's Notion page (inside the Second Brain) with their
 * Super-partner entitlements: add a "Super Partner" badge, record the
 * fulfillment / gift card / company ids in the Notes, and bump Last Activity.
 * Best-effort — the Notion page may not exist for KV-only applications.
 */
async function syncPartnerToNotion(env: Env, input: { candidateId?: string; appRef: string; fullName?: string; fulfillmentId?: string; giftCardId?: string; companyId?: string; trackUrl?: string; notionUrl?: string }): Promise<{ ok: boolean; error?: string }> {
  if (!env.NOTION_TOKEN || !input.candidateId) return { ok: false, error: 'notion not configured' };
  try {
    const lines = [
      `✅ SUPER partner provisioned (${new Date().toISOString()})`,
      `• Application: ${input.appRef}`,
      `• Fulfillment: ${input.fulfillmentId || '—'}`,
      `• Gift card: ${input.giftCardId || '—'}`,
      `• Company: ${input.companyId || '—'}`,
      input.trackUrl ? `• Track: ${input.trackUrl}` : '',
    ].filter(Boolean).join('\n');

    const body = JSON.stringify({
      properties: {
        'Badges': { multi_select: [{ name: 'Super Partner' }] },
        'Last Activity': { date: { start: new Date().toISOString() } },
        'Notes': { rich_text: [{ text: { content: lines } }] },
      },
    });
    const resp = await fetch(`https://api.notion.com/v1/pages/${input.candidateId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body,
    });
    if (!resp.ok) return { ok: false, error: `notion PATCH HTTP ${resp.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * INSTALLMENT ECOSYSTEM BROADCAST — every installment lifecycle event
 * fans out so the WHOLE ecosystem stays in sync:
 *   · Notion   — candidate page Notes + Last Activity
 *   · Airtable — Build Candidates ledger (plan, paid, status)
 *   · Hub      — event bus → Telegram / SMS / n8n
 *   · GitHub   — collaborator access revoked on suspend, restored on resume
 *   · KB (D1)  — AI-searchable installment snapshot
 * Best-effort everywhere; never throws.
 * ───────────────────────────────────────────────────────────────────── */

/** Build a human-readable installment status summary from a plan. */
function installmentSummary(plan: InstallmentPlan): string {
  const paid = plan.installments.filter((i) => i.status === 'PAID').length;
  const paidAmt = plan.installments.filter((i) => i.status === 'PAID').reduce((a, i) => a + i.amount, 0);
  const next = plan.installments.find((i) => i.status !== 'PAID');
  return [
    `Plan: ${plan.plan} (${plan.installments.length} payments)`,
    `Status: ${plan.status}`,
    `Paid: ${paid}/${plan.installments.length} · SAR ${paidAmt} / ${plan.total}`,
    next ? `Next due: ${next.label} SAR ${next.amount} on ${next.dueAt.slice(0, 10)}` : 'All settled',
  ].join('\n');
}

/** Find the GitHub username + repo for an application (for suspend/resume). */
async function partnerGitHubInfo(env: Env, appRef: string): Promise<{ username?: string; repo?: string }> {
  try {
    const rec = (await env.APPLICATIONS.get(`github-provisioned:${appRef}`, 'json')) as { repoUrl?: string; githubUsername?: string } | null;
    const repo = rec?.repoUrl ? rec.repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '') : undefined;
    return { username: rec?.githubUsername, repo };
  } catch { return {}; }
}

/** Revoke / restore a partner's GitHub collaborator access. */
async function setGitHubAccess(env: Env, appRef: string, enabled: boolean): Promise<void> {
  const { username, repo } = await partnerGitHubInfo(env, appRef);
  if (!env.GITHUB_TOKEN || !username || !repo) return;
  const ghHeaders = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'brainsait-build-apply',
  };
  try {
    if (enabled) {
      await fetch(`https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(username)}`, {
        method: 'PUT', headers: ghHeaders, body: JSON.stringify({ permission: 'push' }),
      });
    } else {
      await fetch(`https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(username)}`, {
        method: 'DELETE', headers: ghHeaders,
      });
    }
  } catch { /* best-effort */ }
}

/** Broadcast one installment lifecycle snapshot across the ecosystem. */
async function broadcastInstallment(env: Env, plan: InstallmentPlan, event: string, reason?: string): Promise<void> {
  const summary = installmentSummary(plan);
  const paid = plan.installments.filter((i) => i.status === 'PAID').length;
  const paidAmt = plan.installments.filter((i) => i.status === 'PAID').reduce((a, i) => a + i.amount, 0);

  // 1. Notion — append the installment snapshot to the candidate page.
  try {
    const found = await findApplicationByRef(env, plan.ref);
    if (found?.id && env.NOTION_TOKEN) {
      const lines = [
        `📅 Installment update — ${event} (${new Date().toISOString()})`,
        ...summary.split('\n').map((l) => `• ${l}`),
        reason ? `• Reason: ${reason}` : '',
      ].filter(Boolean).join('\n');
      await notionRequest(env, 'PATCH', `/pages/${found.id}`, {
        properties: {
          'Notes': { rich_text: [{ text: { content: lines } }] },
          'Last Activity': { date: { start: new Date().toISOString() } },
          'Badges': { multi_select: [{ name: event === 'suspended' ? 'Suspended' : plan.status === 'COMPLETED' ? 'Paid' : 'Activated' }] },
        },
      });
    }
  } catch { /* best-effort */ }

  // 2. Airtable — mirror the plan + payment state into the Build Candidates ledger.
  try {
    await syncAirtableCandidate(env, {
      fullName: plan.fullName || 'Founder',
      email: plan.email,
      phone: plan.phone,
      country: '',
      githubUsername: (await partnerGitHubInfo(env, plan.ref)).username,
      appRef: plan.ref,
      tier: 'STANDARD',
      finalPrice: plan.total,
      paymentStatus: plan.status === 'SUSPENDED' ? 'Suspended' : plan.status === 'COMPLETED' ? 'Paid' : 'Pending',
      applicationStatus: plan.status === 'COMPLETED' ? 'Approved' : 'New',
      track: 'Founder Accelerator',
      notionUrl: (await findApplicationByRef(env, plan.ref))?.url,
    });
  } catch { /* best-effort */ }

  // 3. Hub event bus — Telegram / SMS / n8n see every event.
  try {
    await emitHubEvent(env, {
      type: `installment.${event}`,
      source: 'build-apply',
      data: {
        applicationId: plan.ref,
        email: plan.email,
        fullName: plan.fullName,
        plan: plan.plan,
        status: plan.status,
        paid,
        total: plan.installments.length,
        paidAmount: paidAmt,
        totalAmount: plan.total,
        summary,
        reason,
        payUrl: installmentPaymentUrl(env, plan.ref, plan, plan.installments.find((i) => i.status !== 'PAID')?.no || 1),
      },
    });
  } catch { /* best-effort */ }

  // 4. GitHub — suspend revokes repo access; resume/paid restores it.
  if (event === 'suspended') await setGitHubAccess(env, plan.ref, false);
  if (event === 'resumed' || event === 'paid') await setGitHubAccess(env, plan.ref, true);

  // 5. KB (D1) — keep the AI-searchable snapshot current.
  try {
    await embedPartnerToKb(env, {
      applicationId: plan.ref,
      email: plan.email,
      fullName: plan.fullName || 'Founder',
      tier: 'STANDARD',
      githubUsername: (await partnerGitHubInfo(env, plan.ref)).username || '',
      trackUrl: `${BUILD_TRACK_URL}?ref=${encodeURIComponent(plan.ref)}`,
      notionUrl: (await findApplicationByRef(env, plan.ref))?.url || '',
      orderId: plan.installments.find((i) => i.status === 'PAID')?.orderId || '',
    });
  } catch { /* best-effort */ }
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

    if (!payload.fullName || !payload.email) {
      return jsonResponse({ ok: false, error: 'Missing required fields: fullName, email' }, 400, origin);
    }
    if (!validateEmail(payload.email)) {
      return jsonResponse({ ok: false, error: 'Invalid email address' }, 400, origin);
    }
    // Tiers were cancelled in 2026-08: every seat is the flat standard
    // ticket. Identity is no longer collected by the storefront — default
    // it so legacy data and cohort routing still work.
    payload.identity = payload.identity || 'OTHER';

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
      githubUsername: payload.githubUsername,
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

    // Airtable mirror: every applicant gets an always-current record in the
    // Build Candidates table (updated again when payment lands).
    try {
      await syncAirtableCandidate(env, {
        fullName: payload.fullName,
        email: payload.email,
        phone: payload.phone,
        country: payload.country,
        githubUsername: payload.githubUsername,
        appRef,
        tier: tierLabel(pricing.eligibilityId),
        finalPrice: pricing.finalPrice,
        paymentStatus: kvApp.paymentStatus,
        applicationStatus: kvApp.applicationStatus,
        track: track.name,
        notionUrl: notionPage?.url || undefined,
      });
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
    const planName = (payload.plan === 'flex' || payload.plan === 'split' || payload.plan === 'quarter') ? payload.plan : 'full';
    const installmentPlan = buildInstallmentSchedule(appRef, payload.email, payload.fullName, payload.phone, planName, pricing.finalPrice);
    await saveInstallmentPlan(env, installmentPlan);
    // Broadcast the plan creation so the ecosystem knows (Notion, Airtable,
    // hub/Telegram/SMS/n8n, KB). Skip for full-payment (single 9,630).
    if (planName !== 'full') {
      try { await broadcastInstallment(env, installmentPlan, 'created'); } catch { /* best-effort */ }
    }

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
      params.set('properties[installment_no]', '1');
      params.set('properties[installment_ref]', `inst-${appRef}-1`);
      if (pricing.promoCode) {
        params.set('properties[promo_code]', pricing.promoCode);
      }
      // Promo codes are applied through Shopify's /discount/CODE flow, which
      // pre-applies the code to the session cart and redirects to the store.
      // The discount lands on the session cart (verified live: LAUNCH10 ->
      // 8,667 SAR, FOUNDER15 -> 8,185.50 SAR) and the properties above are
      // preserved when the customer proceeds to checkout.
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
        plan: planName,
        installments: planName === 'full'
          ? null
          : installmentPlan.installments.map((i) => ({
              no: i.no,
              label: i.label,
              amount: i.amount,
              dueAt: i.dueAt,
              payUrl: i.no === 1 ? undefined : installmentPaymentUrl(env, appRef, installmentPlan, i.no),
            })),
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      return handleShopifyWebhook(request, env, ctx);
    }

    if (url.pathname.endsWith('/pdf') && url.pathname.startsWith('/certificate/') && request.method === 'GET') {
      const ref = decodeURIComponent(url.pathname.slice('/certificate/'.length, -'/pdf'.length));
      return handleCertificatePdf(request, env, ref);
    }

    if (url.pathname.endsWith('/sign') && url.pathname.startsWith('/certificate/') && request.method === 'POST') {
      const ref = decodeURIComponent(url.pathname.slice('/certificate/'.length, -'/sign'.length));
      return handleCertificateSign(request, env, ref);
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

    if (url.pathname === '/bot/guide' && request.method === 'POST') {
      return handleBotGuide(request, env);
    }

    if (url.pathname === '/bot/test' && request.method === 'POST') {
      return handleBotTest(request, env);
    }

    if (url.pathname === '/bot/answer' && request.method === 'POST') {
      return handleBotAnswer(request, env);
    }

    if (url.pathname === '/admin/stats' && request.method === 'GET') {
      return handleAdminStats(request, env);
    }

    // "Commerce Pulse" — live Shopify orders + subscriptions ⇄ D1 BUILD state.
    if (url.pathname === '/admin/commerce' && request.method === 'GET') {
      return handleAdminCommerce(request, env);
    }

    // Manual day-advance (simulates a successful subscription billing attempt).
    if (url.pathname === '/admin/advance' && request.method === 'POST') {
      const token = request.headers.get('x-admin-token') || '';
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return jsonResponse({ ok: false, error: 'unauthorized' }, 401, origin);
      }
      const body = (await request.json().catch(() => ({}))) as { email?: string };
      if (!body.email) return jsonResponse({ ok: false, error: 'Missing email' }, 400, origin);
      const r = await advanceStudentDay(env, body.email, 'manual');
      return jsonResponse(r, 200, origin);
    }

    // On-demand reliability sweep: re-provisions any paid BUILD order the
    // webhook missed. Guarded by the same ADMIN_TOKEN as /admin/stats.
    if (url.pathname === '/admin/sweep' && request.method === 'POST') {
      const token = request.headers.get('x-admin-token') || '';
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return jsonResponse({ ok: false, error: 'unauthorized' }, 401, origin);
      }
      await sweepUnprocessedPaidOrders(env);
      return jsonResponse({ ok: true }, 200, origin);
    }

    if (url.pathname === '/admin/dbg' && request.method === 'GET') {
      const token = request.headers.get('x-admin-token') || '';
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return jsonResponse({ ok: false, error: 'unauthorized' }, 401, origin);
      }
      const ref = url.searchParams.get('ref') || '';
      let raw: string | null = null;
      let err = '';
      try {
        if (url.searchParams.get('write') === '1') {
          await env.APPLICATIONS.put(KV_KEY(ref), JSON.stringify({ ref, email: 'worker-write@brainsait.org', ts: Date.now() }));
        }
        raw = await env.APPLICATIONS.get(KV_KEY(ref));
      } catch (e) {
        err = String(e);
      }
      return jsonResponse({
        ok: true,
        ref,
        key: KV_KEY(ref),
        notionConfigured: notionConfigured(env),
        rawLength: raw ? raw.length : 0,
        rawPreview: raw ? raw.slice(0, 300) : null,
        err,
      }, 200, origin);
    }

    // EVENT ROUTER — other systems (Telegram bot, simulator, portal) POST here
    // to update the central student state in D1 and trigger async fan‑out.
    if (url.pathname.startsWith('/events/') && request.method === 'POST') {
      const eventType = decodeURIComponent(url.pathname.slice('/events/'.length));
      const body = (await request.json().catch(() => ({}))) as { student_email?: string; [k: string]: unknown };
      if (!body.student_email) return jsonResponse({ ok: false, error: 'Missing student_email' }, 400, origin);
      try {
        await d1LogEvent(ctx, env, eventType, body.student_email, body);
      } catch { /* best-effort */ }
      return jsonResponse({ ok: true, event: eventType, student_email: body.student_email }, 200, origin);
    }

    // PRODUCT REVIEWS — D1-backed review capture + retrieval (ready to mirror
    // to Shopify's Product Reviews API once the dev-app token is wired).
    if (url.pathname.startsWith('/reviews/')) {
      const slug = decodeURIComponent(url.pathname.slice('/reviews/'.length));
      if (request.method === 'GET') return handleReviews(env, slug, origin);
      if (request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { rating?: number; name?: string; body?: string };
        return handleSubmitReview(env, slug, body, origin);
      }
    }

    // BASMA RECOMMENDER — "which track?" (LEARN / BUILD / SOLUTIONS) matcher.
    // Public + non-sensitive, so it allows any origin (Shopify checkout iframe).
    if (url.pathname === '/recommend' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const res = jsonResponse(recommendTrack(body), 200, origin);
      res.headers.set('Access-Control-Allow-Origin', '*');
      return res;
    }

    // INSTALLMENT SYSTEM endpoints.
    if (url.pathname.startsWith('/installment/') && request.method === 'GET') {
      const ref = decodeURIComponent(url.pathname.slice('/installment/'.length));
      const plan = await getInstallmentPlan(env, ref);
      if (!plan) return jsonResponse({ ok: false, error: 'no installment plan' }, 404, null);
      return jsonResponse({ ok: true, plan: planPublicView(plan) }, 200, null);
    }
    if (url.pathname.startsWith('/installment/') && request.method === 'POST') {
      const ref = decodeURIComponent(url.pathname.slice('/installment/'.length));
      const body = (await request.json().catch(() => ({}))) as { action?: string; reason?: string };
      const plan = await getInstallmentPlan(env, ref);
      if (!plan) return jsonResponse({ ok: false, error: 'no installment plan' }, 404, null);
      if (body.action === 'suspend') {
        plan.status = 'SUSPENDED';
        plan.suspendedAt = new Date().toISOString();
        plan.suspendedReason = body.reason || 'manual suspension';
        await saveInstallmentPlan(env, plan);
        await suspendPartnerAccess(env, plan, plan.suspendedReason, true);
        return jsonResponse({ ok: true, status: 'suspended' }, 200, null);
      }
      if (body.action === 'resume') {
        plan.status = 'ACTIVE';
        plan.suspendedAt = undefined;
        plan.suspendedReason = undefined;
        await saveInstallmentPlan(env, plan);
        await suspendPartnerAccess(env, plan, 'resumed', false);
        await broadcastInstallment(env, plan, 'resumed', 'manual resume');
        return jsonResponse({ ok: true, status: 'active' }, 200, null);
      }
      return jsonResponse({ ok: false, error: 'unknown action' }, 400, null);
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
