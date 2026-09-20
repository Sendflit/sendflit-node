# @sendflit/sdk — Node.js

Transactional email for applications and AI agents. Zero dependencies (Node 18+ native fetch).

## Install

```bash
npm install @sendflit/sdk
```

## Usage

```js
import SendFlit from "@sendflit/sdk";

const sendflit = new SendFlit({ apiKey: process.env.SENDFLIT_API_KEY });

const { id } = await sendflit.send({
  from: "you@yourdomain.com",
  to: "user@example.com",
  subject: "Confirm your email",
  html: "<p>Click <a href='...'>here</a> to confirm.</p>",
});
```

### Attachments

```js
await sendflit.send({
  from: "billing@yourdomain.com",
  to: "user@example.com",
  subject: "Your receipt",
  html: "<p>Thanks for your purchase.</p>",
  attachments: [
    { filename: "receipt.pdf", content: pdfBuffer },          // Buffer/Uint8Array
    { filename: "note.txt", content: "plain text is fine" }, // string
  ],
});
```

### Batch (up to 100)

```js
const { results } = await sendflit.batch([
  { from: "you@yourdomain.com", to: "a@example.com", subject: "Hi A", html: "<p>A</p>" },
  { from: "you@yourdomain.com", to: "b@example.com", subject: "Hi B", html: "<p>B</p>" },
]);
```

### Safe retries (idempotency)

```js
// Retrying with the same key replays the original result instead of
// risking a duplicate send — safe to call again after a timeout.
await sendflit.send({
  from: "you@yourdomain.com",
  to: "user@example.com",
  subject: "Order confirmed",
  html: "<p>…</p>",
}, `order-${orderId}`);

await sendflit.batch(emails, `digest-${new Date().toISOString().slice(0, 10)}`);
```

### Templates

```js
await sendflit.send({
  from: "you@yourdomain.com",
  to: "user@example.com",
  templateId: "tmpl_...",
  variables: { name: "Mehedi" },
});
```

### Scheduled send

```js
await sendflit.send({
  from: "you@yourdomain.com",
  to: "user@example.com",
  subject: "Diges",
  html: "<p>…</p>",
  scheduledAt: new Date("2026-09-05T09:00:00Z").toISOString(),
});
```

### Webhook verification

```js
import { verifyWebhookSignature } from "@sendflit/sdk";

app.post("/webhooks/sendflit",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!verifyWebhookSignature(WEBHOOK_SECRET, req.body, req.headers["x-sendflit-signature"])) {
      return res.status(401).end();
    }
    const event = JSON.parse(req.body);
    if (event.type === "email.bounced") { /* suppress, alert, … */ }
    res.status(200).end();
  });
```

## API

### `new SendFlit({ apiKey, baseUrl?, timeout?, maxRetries? })`

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | required, starts with `re_` |
| `baseUrl` | `https://api.sendflit.com` | self-host? point it here |
| `timeout` | `15000` | per request, ms |
| `maxRetries` | `2` | retries 429/5xx with backoff (respects `Retry-After`) |

### Methods

| Method | Endpoint |
|---|---|
| `send(email, idempotencyKey?)` | `POST /v1/email` |
| `batch(emails, idempotencyKey?)` | `POST /v1/emails/batch` |
| `listEmails({limit, offset, status})` | `GET /v1/emails` |
| `getEmail(id)` / `cancelEmail(id)` | `GET/DELETE /v1/emails/{id}` |
| `addDomain(name)` / `listDomains()` / `verifyDomain(id)` | `/v1/domains…` |
| `createTemplate(t)` / `listTemplates()` | `/v1/templates…` |
| `addContact(c)` / `listContacts(q)` | `/v1/contacts…` |
| `suppress({email, reason})` | `POST /v1/suppressions` |
| `usage()` / `health()` | `/v1/usage`, `/v1/health` |

### Errors

`SendFlitError` with `.status` and `.body`. Retries exhaust → the final error is thrown.

MIT © SendFlit
