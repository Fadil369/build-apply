/**
 * BrainSAIT Email Sender — sends templated emails via Resend.
 *
 * Integrates with the build-apply worker's existing Resend config.
 * Each plan type triggers the correct thank-you + welcome sequence.
 */

import {
  learnThankYou, learnWelcome,
  buildThankYou, buildWelcome,
  solutionThankYou,
  bprThankYou,
} from "./templates";

interface EmailEnv {
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
}

interface OrderData {
  customerEmail: string;
  customerName: string;
  productType: string; // "LEARN", "BUILD", "SOLUTIONS", "SOLUTIONS READY", "OID & Registry"
  productHandle: string;
  variantTitle: string;
  orderId: string;
  spid?: string;
}

const FROM = "BrainSAIT <orders@brainsait.org>";

async function sendEmail(
  env: EmailEnv,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Send the appropriate email sequence based on product type.
 * Called from the orders/paid webhook handler.
 */
export async function sendOrderEmails(
  env: EmailEnv,
  order: OrderData,
): Promise<{ thankYou: boolean; welcome: boolean }> {
  const { customerEmail, customerName, productType, productHandle, spid } = order;
  const name = customerName || "there";
  const firstName = name.split(" ")[0] || name;

  let thankYouHtml = "";
  let welcomeHtml = "";
  let thankYouSubject = "";
  let welcomeSubject = "";

  const pt = productType.toUpperCase();

  if (pt.includes("LEARN")) {
    thankYouHtml = learnThankYou(firstName, order.productHandle);
    welcomeHtml = learnWelcome(firstName, "https://f.io/dcOtN3Lf");
    thankYouSubject = `Thank you for your purchase — BrainSAIT LEARN`;
    welcomeSubject = `Your LEARN access is ready — BrainSAIT`;
  } else if (pt.includes("BUILD")) {
    thankYouHtml = buildThankYou(firstName);
    welcomeHtml = buildWelcome(
      firstName,
      "https://fadil369.notion.site/Founder-OS-3ba3479c6f628117966fd1be6c120ac2",
      "https://t.me/brainsait_forge_bot",
    );
    thankYouSubject = `Welcome to BUILD — BrainSAIT Incubation`;
    welcomeSubject = `Your BUILD workspace is ready — BrainSAIT`;
  } else if (pt.includes("SOLUTION") && pt.includes("READY")) {
    thankYouHtml = solutionThankYou(firstName, "ready");
    thankYouSubject = `Solution Ready — BrainSAIT`;
    // No separate welcome for ready-built (handled by calendar invite)
  } else if (pt.includes("SOLUTION")) {
    thankYouHtml = solutionThankYou(firstName, "monthly");
    thankYouSubject = `Welcome to SOLUTIONS — BrainSAIT`;
    welcomeHtml = buildWelcome(
      firstName,
      "https://fadil369.notion.site/Founder-OS-3ba3479c6f628117966fd1be6c120ac2",
      "https://t.me/brainsait_forge_bot",
    );
    welcomeSubject = `Your SOLUTIONS access is ready — BrainSAIT`;
  } else if (pt.includes("OID") || pt.includes("REGISTRY") || pt.includes("BPR")) {
    thankYouHtml = bprThankYou(firstName, spid || "SA-PHY-000001");
    thankYouSubject = `Welcome to BPR — BrainSAIT Provider Registry`;
  } else {
    // Generic thank-you
    thankYouHtml = learnThankYou(firstName, order.productHandle);
    thankYouSubject = `Thank you for your purchase — BrainSAIT`;
  }

  const thankYou = await sendEmail(env, customerEmail, thankYouSubject, thankYouHtml);
  let welcome = true;
  if (welcomeHtml) {
    welcome = await sendEmail(env, customerEmail, welcomeSubject, welcomeHtml);
  }

  return { thankYou, welcome };
}
