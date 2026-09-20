// smoke-test the SDK against the local API server
import assert from "node:assert";

const BASE = process.env.SF_BASE || "http://127.0.0.1:9353";
const { default: SendFlit, verifyWebhookSignature, SendFlitError } =
  await import("../src/index.js");

// --- constructor validation
assert.throws(() => new SendFlit({}), /apiKey/);

const sf = new SendFlit({ apiKey: "re_test", baseUrl: BASE, maxRetries: 0 });

// --- health
const h = await sf.health();
assert.ok(h.status === "ok" || h.ok || h.healthy, "health response");

// --- auth error surfaces as SendFlitError with status
try {
  await sf.listEmails();
  assert.fail("should have thrown 401");
} catch (e) {
  assert.ok(e instanceof SendFlitError, "SendFlitError instance");
  assert.equal(e.status, 401);
}

// --- normalization: arrays→strings, camelCase→snake_case, attachments→b64
const sf2 = new SendFlit({ apiKey: "re_x", baseUrl: BASE, maxRetries: 0 });
// grab the private normalizer through a crafted server: spin an echo check
import http from "node:http";
const echo = http.createServer((req, res) => {
  let b = "";
  req.on("data", c => b += c);
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, echo: b ? JSON.parse(b) : null,
      idempotencyKey: req.headers["idempotency-key"] || null }));
  });
});
await new Promise(r => echo.listen(9399, r));
const sf3 = new SendFlit({ apiKey: "re_x", baseUrl: "http://127.0.0.1:9399", maxRetries: 0 });
const { echo: payload } = await sf3.send({
  from: "a@b.com", to: "c@d.com", cc: ["x@y.com", "z@w.com"],
  replyTo: "r@b.com", templateId: "t1",
  attachments: [{ filename: "f.txt", content: "hi" }],
});
assert.deepEqual(payload.cc, ["x@y.com", "z@w.com"]);
assert.equal(payload.reply_to, "r@b.com");
assert.equal(payload.template_id, "t1");
assert.equal(payload.attachments[0].content_b64, Buffer.from("hi").toString("base64"));

// --- idempotency key: sent as a header, absent when not passed
const withKey = await sf3.send({ from: "a@b.com", to: "c@d.com" }, "order-123");
assert.equal(withKey.idempotencyKey, "order-123");
const withoutKey = await sf3.send({ from: "a@b.com", to: "c@d.com" });
assert.equal(withoutKey.idempotencyKey, null);
const batchWithKey = await sf3.batch([{ from: "a@b.com", to: "c@d.com" }], "batch-1");
assert.equal(batchWithKey.idempotencyKey, "batch-1");

echo.close();

// --- webhook signature
import { createHmac } from "node:crypto";
const secret = "whsec_test", body = JSON.stringify({ type: "email.sent", data: {} });
const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
assert.ok(verifyWebhookSignature(secret, body, good));
assert.ok(!verifyWebhookSignature(secret, body + " ", good));
assert.ok(!verifyWebhookSignature(secret, body, "sha256=deadbeef"));

// --- batch validation
await assert.rejects(() => sf2.batch([]), TypeError);
await assert.rejects(() => sf2.batch(new Array(101).fill({})), RangeError);

console.log("ALL SDK TESTS PASSED");
process.exit(0);
