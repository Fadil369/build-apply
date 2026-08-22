// ─────────────────────────────────────────────────────────────────────────────
// Open Badges 3.0 (OB 3.0) credential system for BrainSAIT BUILD graduates.
//
// Issues a portable, verifiable digital badge alongside the completion
// certificate. The badge is IMS Open Badges 3.0 compliant — the same standard
// Credly and LinkedIn use — so graduates can import it into Credly, LinkedIn,
// or any OB 3.0 consumer, and anyone can verify it at the public badge URL.
//
// Endpoints (see index.ts routing):
//   GET /badge/:ref                 → shareable, Credly-style badge page (HTML)
//   GET /badge/:ref/credential.json → OB 3.0 VerifiableCredential (JSON-LD)
//   GET /badge/:ref/image.svg       → luxury SVG badge image
//   GET /badge-class/:slug          → the BadgeClass (Achievement) JSON-LD
// ─────────────────────────────────────────────────────────────────────────────

export interface BadgeData {
  name: string;
  code: string;
  appRef: string;
  trackName: string;
  issuedAt: string;
}

// Deterministic, stable UUID derived from a seed string (the certificate code).
// Lets us mint a stable AchievementSubject id without extra storage/backfill.
export function deterministicUuid(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = (h >>> ((i % 4) * 8)) & 0xff;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function badgeClassSlug(trackName: string): string {
  const slug = (trackName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'founder-accelerator';
}

export function badgeClassForTrack(trackName: string, base: string) {
  const slug = badgeClassSlug(trackName);
  const safeTrack = trackName || 'Founder Accelerator';
  return {
    id: `${base}/badge-class/${slug}`,
    type: ['Achievement'],
    name: `BrainSAIT BUILD — ${safeTrack}`,
    description:
      'Completed the BrainSAIT BUILD incubation program — 16 days, 16 milestones and 18 labs — and shipped a working capstone project.',
    criteria: {
      narrative: 'Complete all 16 BUILD milestones, including the final capstone project, to earn this badge.',
    },
    image: { id: `${base}/badge-image.svg`, type: 'Image' },
    creator: { id: 'https://brainsait.org', type: ['Profile'], name: 'BrainSAIT' },
    alignment: [
      { targetName: 'Learn', targetUrl: 'https://fadil369.github.io/learn', targetDescription: 'Foundations of learning' },
      { targetName: 'Build', targetUrl: 'https://fadil369.github.io/build', targetDescription: 'Building and shipping' },
      { targetName: 'Solutions', targetUrl: 'https://fadil369.github.io/solutions', targetDescription: 'Production solutions' },
    ],
  };
}

// ─── Luxury SVG badge image ─────────────────────────────────────────────────
export function badgeSvg(d: BadgeData): string {
  const safeName = d.name || 'Builder';
  const safeTrack = (d.trackName || 'Founder Accelerator').toUpperCase();
  const safeCode = d.code || '';
  const date = d.issuedAt ? new Date(d.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const nameSize = safeName.length > 24 ? 34 : safeName.length > 16 ? 40 : 46;
  const trackSize = safeTrack.length > 28 ? 20 : 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" role="img" aria-label="BrainSAIT BUILD badge — ${safeName}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#141a33"/><stop offset="0.55" stop-color="#0b1022"/><stop offset="1" stop-color="#131a30"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#e9c46a"/><stop offset="0.5" stop-color="#c9a227"/><stop offset="1" stop-color="#e9c46a"/>
    </linearGradient>
    <linearGradient id="goldVert" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f5dd9d"/><stop offset="1" stop-color="#c9a227"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="60%">
      <stop offset="0" stop-color="#e9c46a" stop-opacity="0.28"/><stop offset="1" stop-color="#e9c46a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="600" fill="none"/>
  <circle cx="300" cy="300" r="294" fill="url(#bg)"/>
  <circle cx="300" cy="300" r="288" fill="none" stroke="url(#gold)" stroke-width="9"/>
  <circle cx="300" cy="300" r="268" fill="none" stroke="#c9a227" stroke-width="2" stroke-opacity="0.55"/>
  <circle cx="300" cy="300" r="252" fill="url(#glow)"/>
  <path d="M300 30 l9 24 h26 l-21 15 8 24 -22 -16 -22 16 8 -24 -21 -15 h26 z" fill="url(#goldVert)"/>
  <text x="300" y="128" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="30" font-weight="bold" fill="#e9c46a" letter-spacing="6">BrainSAIT</text>
  <text x="300" y="158" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#8b93b5" letter-spacing="5">LEARN · BUILD · SOLUTIONS</text>
  <circle cx="300" cy="206" r="30" fill="none" stroke="#c9a227" stroke-width="2"/>
  <text x="300" y="217" text-anchor="middle" font-family="Georgia, serif" font-size="34" font-weight="bold" fill="#e9c46a">B</text>
  <text x="300" y="268" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" letter-spacing="6" fill="#9aa3b5">CERTIFIED BUILDER</text>
  <text x="300" y="330" text-anchor="middle" font-family="Georgia, serif" font-size="${nameSize}" font-weight="bold" fill="#f4f1ea">${escapeXml(safeName)}</text>
  <text x="300" y="368" text-anchor="middle" font-family="Arial, sans-serif" font-size="${trackSize}" letter-spacing="2" fill="#c9a227">${escapeXml(safeTrack)}</text>
  <line x1="150" y1="410" x2="450" y2="410" stroke="#c9a227" stroke-opacity="0.5" stroke-width="1.5"/>
  <text x="300" y="450" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" fill="#8b93b5">№ ${escapeXml(safeCode)}</text>
  <text x="300" y="478" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#5c6480">${date ? `Issued ${date} · ` : ''}brainsait.org</text>
  <circle cx="120" cy="478" r="22" fill="none" stroke="#c9a227" stroke-width="1.5"/>
  <text x="120" y="484" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="bold" fill="#e9c46a">BS</text>
  <circle cx="480" cy="478" r="22" fill="none" stroke="#c9a227" stroke-width="1.5"/>
  <text x="480" y="484" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="bold" fill="#e9c46a">★</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Generic badge template (used as the BadgeClass `image` reference and the
// landing-page showcase). No live date/name — just the class design.
export function badgeClassImageSvg(): string {
  return badgeSvg({ name: 'Your Name Here', code: 'BS-CERT-2026', appRef: 'badge-class', trackName: 'Founder Accelerator', issuedAt: '' });
}

// ─── OB 3.0 Verifiable Credential (JSON-LD) ────────────────────────────────
export function openBadgeCredential(d: BadgeData, base: string): Record<string, unknown> {
  const slug = badgeClassSlug(d.trackName);
  return {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
    ],
    id: `${base}/badge/${encodeURIComponent(d.appRef)}`,
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    name: `BrainSAIT BUILD — ${d.trackName || 'Founder Accelerator'}`,
    issuer: {
      id: 'https://brainsait.org',
      type: ['Profile'],
      name: 'BrainSAIT',
      url: 'https://brainsait.org',
      description: 'BrainSAIT — a luxury digital store for knowledge: Learn · Build · Solutions.',
    },
    issuanceDate: d.issuedAt,
    credentialSubject: {
      id: `urn:uuid:${deterministicUuid(d.code)}`,
      type: ['AchievementSubject'],
      name: d.name,
      achievement: badgeClassForTrack(d.trackName, base),
    },
  };
}

// ─── Shareable badge page (Credly-style) ────────────────────────────────────
export function badgePageHtml(d: BadgeData, base: string): string {
  const safeName = escapeXml(d.name || 'Builder');
  const safeTrack = escapeXml(d.trackName || 'Founder Accelerator');
  const safeCode = escapeXml(d.code || '');
  const date = new Date(d.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const imageUrl = `${base}/badge/${encodeURIComponent(d.appRef)}/image.svg`;
  const credUrl = `${base}/badge/${encodeURIComponent(d.appRef)}/credential.json`;
  const certUrl = `${base}/certificate/${encodeURIComponent(d.appRef)}`;
  const issueYear = new Date(d.issuedAt).getFullYear();
  const linkedinUrl =
    `https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME` +
    `&name=${encodeURIComponent(`BrainSAIT BUILD — ${d.trackName}`)}` +
    `&organizationName=${encodeURIComponent('BrainSAIT')}` +
    `&issueYear=${issueYear}&certUrl=${encodeURIComponent(certUrl)}&certId=${encodeURIComponent(d.code)}`;
  const credlyHint =
    'This badge is Open Badges 3.0 compliant — upload credential.json to Credly, LinkedIn, or any OB 3.0 consumer.';
  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeName} — BrainSAIT BUILD Badge</title>
<meta property="og:title" content="${safeName} — BrainSAIT BUILD Badge" />
<meta property="og:description" content="Verified BrainSAIT BUILD — ${safeTrack} badge." />
<meta property="og:image" content="${imageUrl}" />
<meta property="og:type" content="profile" />
<style>
  :root { --gold:#c9a227; --gold-l:#e9c46a; --ink:#0b1022; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: linear-gradient(160deg,#0b1022,#141a33); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:2rem; color:#eef1fb; }
  .card { width:100%; max-width:460px; background:rgba(255,255,255,.04); border:1px solid rgba(233,196,106,.28); border-radius:28px; padding:2rem; text-align:center; backdrop-filter:blur(10px); }
  .badge { width:210px; height:210px; border-radius:50%; box-shadow:0 20px 60px rgba(201,162,39,.35); margin:0 auto 1.2rem; }
  h1 { font-size:1.5rem; font-weight:700; color:#e9c46a; margin-bottom:.2rem; }
  .track { color:#9aa3b5; font-size:.95rem; margin-bottom:.4rem; }
  .name { font-size:1.35rem; font-weight:700; margin:.5rem 0; }
  .issued { color:#9aa3b5; font-size:.85rem; }
  .meta { margin:1.3rem 0; padding:1rem; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:16px; text-align:left; font-size:.85rem; color:#c6cce6; }
  .meta b { color:#e9c46a; }
  .meta div { padding:.3rem 0; }
  .verify { display:inline-flex; align-items:center; gap:.4rem; font-size:.82rem; font-weight:700; color:#4ef0b0; margin-bottom:1.2rem; }
  .verify .dot { width:8px; height:8px; border-radius:50%; background:#4ef0b0; box-shadow:0 0 10px #4ef0b0; }
  .btns { display:flex; flex-direction:column; gap:.6rem; }
  .btn { display:block; padding:.8rem 1.2rem; border-radius:999px; font-weight:700; font-size:.9rem; text-decoration:none; transition:transform .15s; }
  .btn:hover { transform:translateY(-2px); }
  .btn-gold { background:linear-gradient(135deg,#c9a227,#e9c46a); color:#131320; }
  .btn-ghost { background:rgba(255,255,255,.06); color:#eef1fb; border:1px solid rgba(255,255,255,.14); }
  .hint { margin-top:1.1rem; font-size:.74rem; color:#8b93b5; line-height:1.5; }
  a.link { color:#e9c46a; }
</style>
</head>
<body>
  <div class="card">
    <img class="badge" src="${imageUrl}" alt="BrainSAIT BUILD badge" />
    <h1>BrainSAIT BUILD</h1>
    <div class="track">${safeTrack}</div>
    <div class="name">${safeName}</div>
    <div class="issued">Issued ${date}</div>
    <div class="verify"><span class="dot"></span> Verified</div>
    <div class="meta">
      <div><b>Certificate №</b> · ${safeCode}</div>
      <div><b>Issuer</b> · BrainSAIT</div>
      <div><b>Application</b> · ${escapeXml(d.appRef)}</div>
      <div><b>Criteria</b> · Completed all 16 BUILD milestones</div>
    </div>
    <div class="btns">
      <a class="btn btn-gold" href="${certUrl}">View certificate →</a>
      <a class="btn btn-ghost" href="${credUrl}" download>Download badge (Open Badges 3.0)</a>
      <a class="btn btn-ghost" href="${linkedinUrl}" target="_blank" rel="noopener noreferrer">Add to LinkedIn ↗</a>
    </div>
    <p class="hint">${credlyHint} Verify this badge any time at <a class="link" href="${base}/badge/${encodeURIComponent(d.appRef)}">brainsait.org</a>.</p>
  </div>
</body>
</html>`;
}
