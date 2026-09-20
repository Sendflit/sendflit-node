/**
 * SendFlit Node.js SDK — zero dependencies (native fetch, Node 18+).
 * Transactional email API for applications and AI agents.
 * @module @sendflit/sdk
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_BASE = "https://api.sendflit.com";
const VERSION = "1.1.0";

export class SendFlitError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status code (0 for network errors)
   * @param {object} [body] parsed error body, when available
   */
  constructor(message, status, body) {
    super(message);
    this.name = "SendFlitError";
    this.status = status;
    this.body = body;
  }
}

export class SendFlitTimeoutError extends SendFlitError {
  constructor(timeoutMs) {
    super(`Request timed out after ${timeoutMs}ms`, 0, undefined);
    this.name = "SendFlitTimeoutError";
  }
}

/**
 * @typedef {object} SendFlitOptions
 * @property {string} apiKey      Required. Starts with "re_".
 * @property {string} [baseUrl]   Default https://api.sendflit.com
 * @property {number} [timeout]   Request timeout ms (default 15000)
 * @property {number} [maxRetries] Retries for 429/5xx (default 2)
 */

export class SendFlit {
  /** @param {SendFlitOptions} opts */
  constructor({ apiKey, baseUrl, timeout = 15000, maxRetries = 2 } = {}) {
    if (!apiKey) throw new TypeError("SendFlit: apiKey is required");
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    this.timeout = timeout;
    this.maxRetries = maxRetries;
  }

  /** @private */
  async _request(method, path, body, extraHeaders) {
    const url = `${this.baseUrl}/v1${path}`;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeout);
      let res, data;
      try {
        res = await fetch(url, {
          method,
          signal: ctrl.signal,
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            ...(body !== undefined && { "Content-Type": "application/json" }),
            "User-Agent": `sendflit-node/${VERSION}`,
            ...extraHeaders,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      } catch (e) {
        if (e.name === "AbortError") throw new SendFlitTimeoutError(this.timeout);
        throw new SendFlitError(`Network error: ${e.message}`, 0, undefined);
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) return data;

      const retryable = res.status === 429 || res.status >= 500;
      const retryAfter = Number(res.headers.get("retry-after")) * 1000;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : 2 ** attempt * 300 + Math.random() * 200;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const msg = typeof data.detail === "string" ? data.detail
        : Array.isArray(data.detail) ? data.detail.map(d => d.msg).join("; ")
        : `SendFlit API error (${res.status})`;
      throw new SendFlitError(msg, res.status, data);
    }
  }

  // ------------------------------------------------------------------ email

  /**
   * Send a transactional email.
   * @param {object} email
   * @param {string} email.from      e.g. "you@yourdomain.com" or "Name <you@domain>"
   * @param {string} email.to
   * @param {string} [email.subject] required unless template supplies it
   * @param {string} [email.html]
   * @param {string} [email.text]
   * @param {string|string[]} [email.cc]
   * @param {string|string[]} [email.bcc]
   * @param {string} [email.replyTo]
   * @param {object} [email.headers] custom SMTP headers
   * @param {string} [email.templateId] send with a stored template
   * @param {object} [email.variables] template merge vars
   * @param {Array<{filename: string, content: string|Buffer|Uint8Array, contentType?: string}>} [email.attachments]
   * @param {string} [email.scheduledAt] ISO timestamp — queue for later
   * @param {string} [idempotencyKey] Safe retries: resending the exact same
   *   request with the same key replays the original result (success or
   *   failure) instead of risking a duplicate send. Reusing the key with a
   *   different request body is rejected with 409.
   * @returns {Promise<{id: string, status: string, to: string}>}
   */
  async send(email, idempotencyKey) {
    return this._request("POST", "/email", this._normalize(email), this._idemHeaders(idempotencyKey));
  }

  /**
   * Send up to 100 emails in one call.
   * @param {object[]} emails
   * @param {string} [idempotencyKey] Covers the whole batch — see send().
   */
  async batch(emails, idempotencyKey) {
    if (!Array.isArray(emails) || emails.length === 0) {
      throw new TypeError("batch() expects a non-empty array");
    }
    if (emails.length > 100) {
      throw new RangeError("batch() accepts at most 100 emails per call");
    }
    return this._request("POST", "/emails/batch", { emails: emails.map(e => this._normalize(e)) },
      this._idemHeaders(idempotencyKey));
  }

  /** @private */
  _idemHeaders(key) {
    return key ? { "Idempotency-Key": key } : undefined;
  }

  /** @private */
  _normalize(e) {
    const out = { ...e };
    if (out.replyTo) { out.reply_to = out.replyTo; delete out.replyTo; }
    if (out.templateId) { out.template_id = out.templateId; delete out.templateId; }
    if (out.templateName) { out.template_name = out.templateName; delete out.templateName; }
    if (out.scheduledAt) { out.scheduled_at = out.scheduledAt; delete out.scheduledAt; }
    if (out.toName) { out.to_name = out.toName; delete out.toName; }
    // cc/bcc stay arrays on the wire (API accepts list[EmailStr])
    if (out.attachments) {
      out.attachments = out.attachments.map(a => ({
        filename: a.filename,
        content_b64: typeof a.content === "string"
          ? Buffer.from(a.content, "utf8").toString("base64")
          : Buffer.from(a.content).toString("base64"),
        content_type: a.contentType || "application/octet-stream",
      }));
    }
    // strip undefined so JSON never carries them
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  // ------------------------------------------------------------------ reads

  /** List emails. @param {{limit?: number, offset?: number, status?: string}} [q] */
  async listEmails(q = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined));
    return this._request("GET", `/emails${qs.size ? "?" + qs : ""}`);
  }

  /** @param {string} id */
  async getEmail(id) { return this._request("GET", `/emails/${id}`); }

  /** @param {string} id */
  async cancelEmail(id) { return this._request("DELETE", `/emails/${id}`); }

  // ------------------------------------------------------------- domains

  /** @param {string} name e.g. "acme.com" */
  async addDomain(name) { return this._request("POST", "/domains", { name }); }

  async listDomains() { return this._request("GET", "/domains"); }

  /** @param {string} id */
  async verifyDomain(id) { return this._request("POST", `/domains/${id}/verify`); }

  // ------------------------------------------------------------- templates

  /** @param {{name: string, subject: string, html?: string, text?: string}} t */
  async createTemplate(t) { return this._request("POST", "/templates", t); }

  async listTemplates() { return this._request("GET", "/templates"); }

  // ------------------------------------------------------------- contacts

  /** @param {{email: string, name?: string, audience?: string, data?: object}} c */
  async addContact(c) { return this._request("POST", "/contacts", c); }

  /** @param {{limit?: number, offset?: number, audience?: string}} [q] */
  async listContacts(q = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined));
    return this._request("GET", `/contacts${qs.size ? "?" + qs : ""}`);
  }

  // ------------------------------------------------------------- misc

  async usage() { return this._request("GET", "/usage"); }

  /** Liveness probe (note: root-level, not under /v1). */
  async health() {
    const res = await fetch(`${this.baseUrl}/health`, {
      headers: { "User-Agent": `sendflit-node/${VERSION}` },
    });
    return res.json();
  }

  /** Suppress an address. @param {{email: string, reason?: string}} s */
  async suppress(s) { return this._request("POST", "/suppressions", s); }
}

// ------------------------------------------------------------ webhooks

/**
 * Verify a SendFlit webhook signature.
 * @param {string} secret   the whsec_… secret shown at webhook creation
 * @param {string|Buffer} rawBody  the raw (unparsed) request body
 * @param {string} signature  the X-Sendflit-Signature header value ("sha256=<hex>")
 * @returns {boolean}
 */
export function verifyWebhookSignature(secret, rawBody, signature) {
  const expected = "sha256=" +
    createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Express-style middleware helper (also works with raw-body-attached handlers).
 * Verifies the signature and sets req.sendflitEvent.
 */
export function webhookMiddleware(secret) {
  return (req, res, next) => {
    const raw = req.body && Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));
    const sig = req.headers["x-sendflit-signature"];
    if (!verifyWebhookSignature(secret, raw, sig)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    req.sendflitEvent = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    next();
  };
}

export default SendFlit;
