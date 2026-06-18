import { NextResponse } from "next/server";
import crypto from "crypto";

const GRAPHQL_ENDPOINT = process.env.GRAPHQL_URL ?? "";
const REST_BASE = GRAPHQL_ENDPOINT.replace(/\/graphql$/, "/rest/V1");
const MAGENTO_ADMIN_USER = process.env.MAGENTO_ADMIN_USER ?? "";
const MAGENTO_ADMIN_PASSWORD = process.env.MAGENTO_ADMIN_PASSWORD ?? "";
const REVOLUT_API_SECRET_KEY = process.env.REVOLUT_API_SECRET_KEY ?? "";
const REVOLUT_ENV = process.env.NEXT_PUBLIC_REVOLUT_ENV ?? "sandbox";
const REVOLUT_API_BASE =
  REVOLUT_ENV === "sandbox"
    ? "https://sandbox-merchant.revolut.com/api"
    : "https://merchant.revolut.com/api";
// Signing secret shown when you create the webhook in the Revolut dashboard / API.
const SIGNING_SECRET = process.env.REVOLUT_WEBHOOK_SIGNING_SECRET ?? "";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Server-side backstop for Revolut payments. The checkout places the Magento
// order and invoices it synchronously, but if Revolut's order state lags at that
// moment (so the synchronous invoice is skipped) or that request fails, this
// webhook marks the order paid once Revolut confirms the authorisation.
//
// It maps back to the Magento order via `merchant_order_ext_ref`, which the place
// route sets to the Magento order number after placement.
export async function POST(request: Request) {
  const raw = await request.text();

  if (!SIGNING_SECRET) {
    console.error("REVOLUT_WEBHOOK_SIGNING_SECRET not configured");
    return NextResponse.json({ message: "Not configured" }, { status: 500 });
  }

  const signatureHeader = request.headers.get("revolut-signature") ?? "";
  const timestamp = request.headers.get("revolut-request-timestamp") ?? "";
  if (!signatureHeader || !timestamp) {
    return NextResponse.json({ message: "Missing signature" }, { status: 401 });
  }

  // Replay protection: reject timestamps outside a 5-minute window.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
    return NextResponse.json({ message: "Stale timestamp" }, { status: 401 });
  }

  // payload_to_sign = "v1.{timestamp}.{raw_body}", HMAC-SHA256 with the signing
  // secret, then the header value is "v1={hex}". The header may carry several
  // space-separated signatures (e.g. during a secret rotation).
  const expected =
    "v1=" +
    crypto
      .createHmac("sha256", SIGNING_SECRET)
      .update(`v1.${timestamp}.${raw}`)
      .digest("hex");
  const expectedBuf = Buffer.from(expected);
  const matches = signatureHeader.split(/\s+/).some((sig) => {
    const sigBuf = Buffer.from(sig);
    return (
      sigBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(sigBuf, expectedBuf)
    );
  });
  if (!matches) {
    return NextResponse.json({ message: "Invalid signature" }, { status: 401 });
  }

  let event: {
    event?: string;
    order_id?: string;
    merchant_order_ext_ref?: string;
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ message: "Invalid body" }, { status: 400 });
  }

  // We invoice on authorisation — capture_mode is "manual", so funds are held at
  // ORDER_AUTHORISED. ORDER_COMPLETED (after a later capture) is handled too.
  if (event.event !== "ORDER_AUTHORISED" && event.event !== "ORDER_COMPLETED") {
    return NextResponse.json({ ok: true, ignored: event.event });
  }

  const incrementId = event.merchant_order_ext_ref;
  const revolutOrderId = event.order_id;
  if (!incrementId || !revolutOrderId || !UUID_RE.test(revolutOrderId)) {
    // Nothing to map back to a Magento order — ack so Revolut stops retrying.
    return NextResponse.json({ ok: true, unmapped: true });
  }

  try {
    await ensureOrderInvoiced(incrementId, revolutOrderId);
  } catch (e) {
    console.error("revolut-webhook processing failed:", e);
    // Return 500 so Revolut retries (it backs off and retries failed deliveries).
    return NextResponse.json({ message: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

async function ensureOrderInvoiced(incrementId: string, revolutOrderId: string) {
  if (!MAGENTO_ADMIN_USER || !MAGENTO_ADMIN_PASSWORD || !REVOLUT_API_SECRET_KEY) {
    throw new Error("Admin / Revolut credentials not configured");
  }

  // Verify the Revolut order really is authorised/completed before invoicing.
  const verifyResp = await fetch(`${REVOLUT_API_BASE}/orders/${revolutOrderId}`, {
    headers: {
      Authorization: `Bearer ${REVOLUT_API_SECRET_KEY}`,
      "Revolut-Api-Version": "2024-09-01",
    },
    cache: "no-store",
  });
  if (!verifyResp.ok) throw new Error("Could not verify Revolut order");
  const revolutOrder = await verifyResp.json();
  const state: string = revolutOrder.state ?? "";
  if (state !== "authorised" && state !== "completed") return;

  // Admin token
  const tokenResp = await fetch(`${REST_BASE}/integration/admin/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: MAGENTO_ADMIN_USER,
      password: MAGENTO_ADMIN_PASSWORD,
    }),
  });
  const adminToken: string = await tokenResp.json();
  if (!tokenResp.ok || typeof adminToken !== "string") {
    throw new Error("Admin auth failed");
  }
  const adminHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${adminToken}`,
  };

  // Find the order by increment_id (= merchant_order_ext_ref)
  const searchResp = await fetch(
    `${REST_BASE}/orders?searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=${encodeURIComponent(incrementId)}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`,
    { headers: adminHeaders },
  );
  const searchData = await searchResp.json();
  const order = searchData?.items?.[0];
  const entityId: number | undefined = order?.entity_id;
  if (!entityId) return;

  // Already invoiced? Skip to keep the webhook idempotent (Revolut may resend,
  // and the checkout may have invoiced synchronously already).
  const grandTotal: number = order.grand_total ?? 0;
  const totalInvoiced: number = order.total_invoiced ?? 0;
  if (totalInvoiced >= grandTotal && grandTotal > 0) return;

  // Amount sanity check against the Revolut order.
  const revolutAmountMinor: number | undefined = revolutOrder.order_amount?.value;
  if (
    revolutAmountMinor !== undefined &&
    grandTotal > 0 &&
    revolutAmountMinor !== Math.round(grandTotal * 100)
  ) {
    console.error(
      `revolut-webhook amount mismatch for ${incrementId}: revolut=${revolutAmountMinor} magento=${Math.round(grandTotal * 100)}`,
    );
    return;
  }

  const invoiceResp = await fetch(`${REST_BASE}/order/${entityId}/invoice`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ capture: true, notify: true }),
  });
  if (!invoiceResp.ok) {
    // A 400 here usually means it was invoiced between our check and now — treat
    // as success rather than triggering an endless retry loop.
    const err = await invoiceResp.json().catch(() => ({}));
    console.error("revolut-webhook invoice failed (may already be invoiced):", err);
    return;
  }

  await fetch(`${REST_BASE}/orders/${entityId}/comments`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      statusHistory: {
        comment: `Платено чрез Revolut Pay (потвърдено по webhook). Revolut Order ID: ${revolutOrderId}`,
        is_customer_notified: 0,
        is_visible_on_front: 0,
      },
    }),
  }).catch(() => {});
}
