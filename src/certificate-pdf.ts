import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

// ─────────────────────────────────────────────────────────────────────────────
// Certificate PDF generator (pdf-lib) — a print-grade, landscape certificate
// with gold accents, matching the HTML certificate served at /certificate/:ref.
// Produced in the Worker so it can also be pushed to Adobe Acrobat Sign for the
// founder's electronic signature.
// ─────────────────────────────────────────────────────────────────────────────

const GOLD = rgb(0.79, 0.64, 0.16);
const GOLD_LIGHT = rgb(0.91, 0.77, 0.42);
const INK = rgb(0.08, 0.07, 0.13);
const SUBTLE = rgb(0.45, 0.42, 0.34);

export interface CertificatePdfInput {
  name: string;
  code: string;
  appRef: string;
  track: string;
  issuedAt: string;
}

export async function generateCertificatePdf(input: CertificatePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([1122, 793]); // landscape A4 (points)
  const { width, height } = page.getSize();

  const titleFont = await doc.embedFont(StandardFonts.TimesRomanBold);
  const bodyFont = await doc.embedFont(StandardFonts.TimesRoman);
  const italicFont = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const smallCaps = await doc.embedFont(StandardFonts.HelveticaBold);

  const centerX = width / 2;
  const centerText = (font: typeof bodyFont, size: number, text: string, y: number, color = INK) =>
    page.drawText(text, { x: centerX - font.widthOfTextAtSize(text, size) / 2, y, size, font, color });

  // Parchment background.
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.99, 0.985, 0.955) });

  // Double gold frame.
  page.drawRectangle({ x: 26, y: 26, width: width - 52, height: height - 52, borderColor: GOLD, borderWidth: 3 });
  page.drawRectangle({ x: 40, y: 40, width: width - 80, height: height - 80, borderColor: GOLD, borderWidth: 1 });

  // Corner ornaments (simple gold squares).
  const c = 40, s = 22;
  page.drawRectangle({ x: c, y: c, width: s, height: s, color: GOLD });
  page.drawRectangle({ x: width - c - s, y: c, width: s, height: s, color: GOLD });
  page.drawRectangle({ x: c, y: height - c - s, width: s, height: s, color: GOLD });
  page.drawRectangle({ x: width - c - s, y: height - c - s, width: s, height: s, color: GOLD });

  // Brand.
  const brand = 'BrainSAIT';
  centerText(smallCaps, 16, brand.toUpperCase(), height - 130, GOLD);

  // Seal / sub-brand.
  const seal = 'LEARN · BUILD · SOLUTIONS';
  centerText(smallCaps, 9, seal, height - 156, SUBTLE);

  // Title.
  const title = 'Certificate of Completion';
  centerText(titleFont, 40, title, height - 240, rgb(0.35, 0.29, 0.07));

  // Intro.
  centerText(italicFont, 15, 'This certificate is proudly presented to', height - 292, SUBTLE);

  // Name.
  const safeName = (input.name || 'Builder').slice(0, 60);
  const nameSize = safeName.length > 30 ? 34 : 46;
  centerText(titleFont, nameSize, safeName, height - 360, INK);

  // Track.
  const trackLine = `for completing the ${input.track || 'Founder Accelerator'} — 15 days · 18 labs · 16 milestones`;
  centerText(bodyFont, 13, trackLine, height - 398, SUBTLE);

  // Statement.
  const statement = 'You used your first brain very well — and built a second one with us. This document is our proof, and yours: a story believable enough to be sold, built with tools that last.';
  const words = statement.split(' ');
  let line = '';
  let yy = height - 452;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (bodyFont.widthOfTextAtSize(test, 12) > 620) {
      centerText(bodyFont, 12, line, yy, SUBTLE);
      line = w;
      yy -= 20;
    } else {
      line = test;
    }
  }
  if (line) centerText(bodyFont, 12, line, yy, SUBTLE);

  // Meta row (Number / Application / Issued).
  const metaY = height - 560;
  const col1 = 200, col2 = 480, col3 = 760;
  const metaLabel = (font: typeof bodyFont, text: string, x: number) => page.drawText(text, { x, y: metaY, size: 9, font, color: SUBTLE });
  const metaValue = (font: typeof bodyFont, text: string, x: number) => page.drawText(text, { x, y: metaY - 22, size: 12, font, color: rgb(0.35, 0.29, 0.07) });

  metaLabel(smallCaps, 'CERTIFICATE No.', col1);
  metaValue(bodyFont, input.code, col1);
  metaLabel(smallCaps, 'APPLICATION', col2);
  metaValue(bodyFont, input.appRef, col2);
  metaLabel(smallCaps, 'ISSUED', col3);
  const date = new Date(input.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  metaValue(bodyFont, date, col3);

  // Seal (circular).
  const sealX = 96, sealY = height - 640, sealR = 64;
  page.drawCircle({ x: sealX, y: sealY, size: sealR, borderColor: GOLD, borderWidth: 2 });
  page.drawCircle({ x: sealX, y: sealY, size: sealR - 8, borderColor: GOLD, borderWidth: 1 });
  const sealText = ['THE', 'SECOND', 'BRAIN', 'VERIFIED'];
  sealText.forEach((t, i) => centerText(smallCaps, 8, t, sealY + sealR - 34 - i * 14, GOLD));

  // Signature line (founder).
  const sigX = width - 300;
  const sigLabel = 'FOUNDER & INCUBATION';
  page.drawText(sigLabel, { x: sigX - smallCaps.widthOfTextAtSize(sigLabel, 10) / 2, y: sealY + 30, size: 10, font: smallCaps, color: GOLD });
  page.drawLine({ start: { x: sigX - 90, y: sealY + 8 }, end: { x: sigX + 90, y: sealY + 8 }, thickness: 1, color: GOLD });
  const sigSub = 'BrainSAIT — brainsait.org';
  page.drawText(sigSub, { x: sigX - bodyFont.widthOfTextAtSize(sigSub, 12) / 2, y: sealY - 14, size: 12, font: bodyFont, color: SUBTLE });

  return doc.save();
}
