// ─────────────────────────────────────────────────────────────────────────────
// Adobe Acrobat Sign integration — signs BUILD completion certificates.
//
// Flow:
//   1. OAuth2 client_credentials → access token
//   2. POST /transientDocuments (multipart) → upload the PDF certificate
//   3. POST /agreements → create an ESIGN agreement for the founder
//   4. GET  /agreements/{id}/signingUrls → return the live signing URL
//
// Best-effort and config-gated: without ADOBE_SIGN_* credentials the whole
// path no-ops and certificate delivery falls back to the email + HTML URL.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdobeSignConfig {
  integrationKey?: string;
  clientSecret?: string;
  apiBase?: string; // e.g. https://api.na1.echosign.com
  signerEmail?: string; // the founder/issuer who signs the certificate
}

interface TokenResult {
  accessToken?: string;
  error?: string;
}

async function getAccessToken(cfg: AdobeSignConfig): Promise<TokenResult> {
  if (!cfg.integrationKey || !cfg.clientSecret) return { error: 'not_configured' };
  try {
    const resp = await fetch(`${cfg.apiBase || 'https://api.na1.echosign.com'}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.integrationKey,
        client_secret: cfg.clientSecret,
      }),
    });
    const data = (await resp.json()) as { access_token?: string; error?: string };
    if (!resp.ok || !data.access_token) return { error: data.error || `http ${resp.status}` };
    return { accessToken: data.access_token };
  } catch (e) {
    return { error: String(e) };
  }
}

async function uploadTransientDocument(base: string, token: string, fileName: string, pdf: Uint8Array): Promise<{ id?: string; error?: string }> {
  const form = new FormData();
  form.append('File', new Blob([pdf as unknown as ArrayBuffer], { type: 'application/pdf' }), fileName);
  form.append('File-Name', fileName);
  form.append('Mime-Type', 'application/pdf');
  try {
    const resp = await fetch(`${base}/api/rest/v6/transientDocuments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = (await resp.json()) as { transientDocumentId?: string; message?: string };
    if (!resp.ok) return { error: data.message || `http ${resp.status}` };
    return { id: data.transientDocumentId };
  } catch (e) {
    return { error: String(e) };
  }
}

async function createAgreement(base: string, token: string, transientId: string, name: string, signerEmail: string): Promise<{ id?: string; error?: string }> {
  try {
    const resp = await fetch(`${base}/api/rest/v6/agreements`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `BrainSAIT Completion Certificate — ${name}`,
        fileInfos: [{ transientDocumentId: transientId }],
        participantSetsInfo: [{ memberInfos: [{ email: signerEmail }], role: 'SIGNER', order: 1 }],
        signatureType: 'ESIGN',
        state: 'IN_PROCESS',
      }),
    });
    const data = (await resp.json()) as { id?: string; message?: string };
    if (!resp.ok) return { error: data.message || `http ${resp.status}` };
    return { id: data.id };
  } catch (e) {
    return { error: String(e) };
  }
}

async function signingUrl(base: string, token: string, agreementId: string): Promise<{ url?: string; error?: string }> {
  try {
    const resp = await fetch(`${base}/api/rest/v6/agreements/${agreementId}/signingUrls`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await resp.json()) as { signingUrlSetInfos?: { signingUrls?: { electronicSignUrl?: string }[] }[] };
    const url = data.signingUrlSetInfos?.[0]?.signingUrls?.[0]?.electronicSignUrl;
    if (!resp.ok || !url) return { error: `no signing url (http ${resp.status})` };
    return { url };
  } catch (e) {
    return { error: String(e) };
  }
}

export interface AdobeSignResult {
  ok: boolean;
  agreementId?: string;
  signingUrl?: string;
  error?: string;
}

/** Sign a certificate PDF via Adobe Acrobat Sign and return the signing URL. */
export async function signCertificateWithAdobe(
  cfg: AdobeSignConfig,
  pdf: Uint8Array,
  meta: { name: string; code: string },
): Promise<AdobeSignResult> {
  if (!cfg.integrationKey || !cfg.clientSecret) {
    return { ok: false, error: 'adobe_sign_not_configured' };
  }
  const base = cfg.apiBase || 'https://api.na1.echosign.com';
  const signerEmail = cfg.signerEmail;
  if (!signerEmail) return { ok: false, error: 'adobe_signer_email_not_configured' };

  const tok = await getAccessToken(cfg);
  if (!tok.accessToken) return { ok: false, error: `oauth: ${tok.error}` };

  const up = await uploadTransientDocument(base, tok.accessToken, `BrainSAIT-Certificate-${meta.code}.pdf`, pdf);
  if (!up.id) return { ok: false, error: `upload: ${up.error}` };

  const ag = await createAgreement(base, tok.accessToken, up.id, meta.name, signerEmail);
  if (!ag.id) return { ok: false, error: `agreement: ${ag.error}` };

  const sig = await signingUrl(base, tok.accessToken, ag.id);
  if (!sig.url) return { ok: true, agreementId: ag.id, error: `signing_url: ${sig.error}` };

  return { ok: true, agreementId: ag.id, signingUrl: sig.url };
}
