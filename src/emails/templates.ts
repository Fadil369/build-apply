/**
 * BrainSAIT Email Templates — bilingual AR/EN thank-you + welcome sequences.
 *
 * Each plan type has:
 * 1. Thank-you email (immediate after purchase)
 * 2. Welcome email (with access links and onboarding)
 *
 * Templates use inline CSS for email client compatibility.
 */

const BRAND = {
  name: "BrainSAIT",
  color: "#0a3d3b",
  accent: "#2dd4bf",
  gold: "#d4af37",
  bg: "#f8fafa",
  text: "#1a1a1a",
  muted: "#666",
  url: "https://brainsait.org",
  storeUrl: "https://store.brainsait.de",
};

function wrap(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:system-ui,-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:${BRAND.color};padding:24px 32px;">
              <h1 style="margin:0;color:#fff;font-size:22px;">${BRAND.name}</h1>
              <p style="margin:4px 0 0;color:${BRAND.accent};font-size:13px;">Identity · Intelligence · Integration</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="background:#f0f0f0;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:${BRAND.muted};">
                © ${new Date().getFullYear()} BrainSAIT Ltd · Riyadh, Saudi Arabia<br>
                <a href="${BRAND.url}" style="color:${BRAND.accent};text-decoration:none;">brainsait.org</a> ·
                <a href="${BRAND.storeUrl}" style="color:${BRAND.accent};text-decoration:none;">store.brainsait.de</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---- LEARN ----

export function learnThankYou(name: string, product: string): string {
  return wrap(`
    <h2 style="margin:0 0 8px;color:${BRAND.color};">Thank you for your purchase! 🎉</h2>
    <p style="margin:0 0 16px;color:${BRAND.text};">Hi ${name},</p>
    <p style="margin:0 0 16px;color:${BRAND.text};">
      You've purchased <strong>${product}</strong> from BrainSAIT.
      Your access is ready immediately.
    </p>
    <div style="background:#f0faf8;border-radius:8px;padding:16px;margin:16px 0;border-left:4px solid ${BRAND.accent};">
      <p style="margin:0 0 8px;font-weight:600;color:${BRAND.color};">📚 What you get:</p>
      <ul style="margin:0;padding-left:20px;color:${BRAND.text};">
        <li>Instant PDF download link (sent separately)</li>
        <li>Online access to all LEARN collection products</li>
        <li>Access valid until your next payment</li>
      </ul>
    </div>
    <p style="margin:16px 0;color:${BRAND.text};">
      <a href="${BRAND.storeUrl}/account" style="display:inline-block;background:${BRAND.color};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
        Access Your Products
      </a>
    </p>
    <p style="margin:16px 0 0;color:${BRAND.muted};font-size:13px;">
      Questions? Reply to this email or visit <a href="${BRAND.url}" style="color:${BRAND.accent};">brainsait.org</a>
    </p>
  `);
}

export function learnWelcome(name: string, pdfLink: string): string {
  return wrap(`
    <h2 style="margin:0 0 8px;color:${BRAND.color};">Welcome to BrainSAIT LEARN 📚</h2>
    <p style="margin:0 0 16px;color:${BRAND.text};">Hi ${name},</p>
    <p style="margin:0 0 16px;color:${BRAND.text};">
      Your LEARN subscription is active. Here's everything you need to get started:
    </p>
    <div style="background:#f0faf8;border-radius:8px;padding:16px;margin:16px 0;border-left:4px solid ${BRAND.accent};">
      <p style="margin:0 0 8px;font-weight:600;color:${BRAND.color};">🔑 Your access links:</p>
      <ul style="margin:0;padding-left:20px;color:${BRAND.text};">
        <li><a href="${pdfLink}" style="color:${BRAND.accent};">PDF Library</a> — all LEARN products in one link</li>
        <li><a href="${BRAND.storeUrl}/account" style="color:${BRAND.accent};">Account Dashboard</a> — manage your subscription</li>
      </ul>
    </div>
    <div style="background:#fff8e6;border-radius:8px;padding:16px;margin:16px 0;border-left:4px solid ${BRAND.gold};">
      <p style="margin:0 0 8px;font-weight:600;color:${BRAND.color};">💡 Next step:</p>
      <p style="margin:0;color:${BRAND.text};">
        Ready to build? Upgrade to the <a href="${BRAND.storeUrl}/products/build-forge-incubator-founders-program-1" style="color:${BRAND.accent};">BUILD program</a>
        for Notion pages, Telegram bot access, and hands-on incubation.
      </p>
    </div>
    <p style="margin:16px 0 0;color:${BRAND.muted};font-size:13px;">
      Your subscription renews automatically monthly. Cancel anytime from your account.
    </p>
  `);
}

// ---- BUILD ----

export function buildThankYou(name: string): string {
  return wrap(`
    <h2 style="margin:0 0 8px;color:${BRAND.color};">Welcome to BUILD! 🚀</h2>
    <p style="margin:0 0 16px;color:${BRAND.text};">Hi ${name},</p>
    <p style="margin:0 0 16px;color:${BRAND.text};">
      You've joined the BrainSAIT BUILD Incubation Program.
      Your founder journey starts now.
    </p>
    <div style="background:#f0faf8;border-radius:8px;padding:16px;margin:16px 0;border-left:4px solid ${BRAND.accent};">
      <p style="margin:0 0 8px;font-weight:600;color:${BRAND.color};">🏗️ What you get:</p>
      <ul style="margin:0;padding-left:20px;color:${BRAND.text};">
        <li>Full LEARN library access (PDF + online)</li>
        <li>Notion pages with Forge Incubator courses</li>
        <li>Telegram bot (Brainsait_fotge_bot) with tracking</li>
        <li>14-day curriculum with milestones</li>
        <li>Progress follow-up and guidance</li>
      </ul>
    </div>
    <p style="margin:16px 0;color:${BRAND.text};">
      <a href="https://fadil369.notion.site/Founder-OS-3ba3479c6f628117966fd1be6c120ac2" style="display:inline-block;background:${BRAND.color};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
        Open Notion Dashboard
      </a>
      &nbsp;
      <a href="https://t.me/brainsait_forge_bot" style="display:inline-block;background:transparent;border:2px solid ${BRAND.color};color:${BRAND.color};padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
        Start Telegram Bot
      </a>
    </p>
  `);
}

export function buildWelcome(name: string, notionUrl: string, telegramUrl: string): string {
  return wrap(`
    <h2 style="margin:0 0 8px;color:${BRAND.color};">Your BUILD workspace is ready 🏗️</h2>
    <p style="margin:0 0 16px;color:${BRAND.text};">Hi ${name},</p>
    <div style="background:#f0faf8;border-radius:8px;padding:16px;margin:16px 0;border-left:4px solid ${BRAND.accent};">
      <p style="margin:0 0 8px;font-weight:600;color:${BRAND.color};">📋 Onboarding checklist:</p>
      <ol style="margin:0;padding-left:20px;color:${BRAND.text};">
        <li>Join the Telegram bot for daily tracking</li>
        <li>Open your Notion workspace for courses</li>
        <li>Complete Day 1 milestone in the curriculum</li>
        <li>Book your first check-in call</li>
      </ol>
    </div>
    <p style="margin:16px 0;color:${BRAND.text};">
      <a href="${notionUrl}" style="color:${BRAND.accent};">📚 Notion Workspace</a> ·
      <a href="${telegramUrl}" style="color:${BRAND.accent};">🤖 Telegram Bot</a> ·
      <a href="https://calendar.app.google/rAqiE6pNumtECdnd7" style="color:${BRAND.accent};">📅 Book Call</a>
    </p>
    <p style="margin:16px 0 0;color:${BRAND.muted};font-size:13px;">
      30-day access validity. Progress tracked automatically.
    </p>
  `);
}

// ---- SOLUTION ----

export function solutionThankYou(name: string, type: "monthly" | "ready"): string {
  const isReady = type === "ready";
  return wrap(`
    <h2 style="margin:0 0 8px;color:${BRAND.color};">${isReady ? "Solution Ready! 🎯" : "Welcome to SOLUTIONS 🤝"}</h2>
    <p style="margin:0 0 16px;color:${BRAND.text};">Hi ${name},</p>
    <p style="margin:0 0 16px;color:${BRAND.text};">
      ${isReady
        ? "You've purchased a pre-built solution. We'll reach out within 24 hours to schedule your setup meeting."
        : "You've joined the BrainSAIT SOLUTIONS program — Learn + Build + Super-Partner access."}
    </p>
    <div style="background:#f0faf8;border-radius:8px;padding:16px;margin:16px 0;border-left:4px solid ${BRAND.accent};">
      ${isReady ? `
        <p style="margin:0 0 8px;font-weight:600;color:${BRAND.color};">📦 What happens next:</p>
        <ul style="margin:0;padding-left:20px;color:${BRAND.text};">
          <li>Google Calendar invite for setup meeting</li>
          <li>Google Form to collect your requirements</li>
          <li>Source code and infrastructure packaging</li>
          <li>Step-by-step deployment with your team</li>
        </ul>
      ` : `
        <p style="margin:0 0 8px;font-weight:600;color:${BRAND.color};">🌟 Your access includes:</p>
        <ul style="margin:0;padding-left:20px;color:${BRAND.text};">
          <li>Full LEARN library + BUILD program</li>
          <li>Super-Partner Lark system access</li>
          <li>BrainSAIT Code platform workspace</li>
          <li>Incubation: deployment → marketing → graduation</li>
          <li>Certifications and badge release</li>
        </ul>
      `}
    </div>
    <p style="margin:16px 0;color:${BRAND.text};">
      <a href="https://calendar.app.google/Ve9KSKmaVA6ehDP48" style="display:inline-block;background:${BRAND.color};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
        ${isReady ? "Schedule Setup Call" : "Book Strategy Session"}
      </a>
    </p>
  `);
}

// ---- BPR ----

export function bprThankYou(name: string, spid: string): string {
  return wrap(`
    <h2 style="margin:0 0 8px;color:${BRAND.color};">Welcome to BPR! 🏥</h2>
    <p style="margin:0 0 16px;color:${BRAND.text};">Hi ${name},</p>
    <p style="margin:0 0 16px;color:${BRAND.text};">
      Your BrainSAIT Provider Registry membership is active.
      Your professional identity is now verified under IANA PEN 61026.
    </p>
    <div style="background:#f0faf8;border-radius:8px;padding:16px;margin:16px 0;border-left:4px solid ${BRAND.accent};">
      <p style="margin:0 0 8px;font-weight:600;color:${BRAND.color};">🏥 Your identity:</p>
      <ul style="margin:0;padding-left:20px;color:${BRAND.text};">
        <li>SPID: <strong>${spid}</strong></li>
        <li>Public profile: <a href="https://verify.brainsait.org/${spid}" style="color:${BRAND.accent};">verify.brainsait.org/${spid}</a></li>
        <li>QR code for instant verification</li>
        <li>FHIR R4 API access</li>
        <li>Clinical copilot (bilingual AR/EN)</li>
      </ul>
    </div>
    <p style="margin:16px 0;color:${BRAND.text};">
      <a href="https://registry.brainsait.org" style="display:inline-block;background:${BRAND.color};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
        Open Registry Dashboard
      </a>
      &nbsp;
      <a href="https://verify.brainsait.org/${spid}" style="display:inline-block;background:transparent;border:2px solid ${BRAND.color};color:${BRAND.color};padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
        View Verification Page
      </a>
    </p>
  `);
}
