import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { Mutations, Queries } from "@/src/app/utils/graphql";
import { verifyTurnstile } from "@/src/app/utils/turnstile";
import { print } from "graphql";

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

interface ShippingAddress {
  firstname: string;
  lastname: string;
  street: string | string[];
  city: string;
  region: string;
  postcode: string;
  country_code: string;
  telephone: string;
  company?: string;
}

export async function POST(request: NextRequest) {
  try {
    if (!GRAPHQL_ENDPOINT) {
      return NextResponse.json(
        { message: "Server not configured" },
        { status: 500 },
      );
    }

    const cookieStore = await cookies();
    const authToken = cookieStore.get("auth-token")?.value;
    const cartId = cookieStore.get("cart-id")?.value;

    if (!cartId) {
      return NextResponse.json({ message: "No cart found" }, { status: 404 });
    }

    const {
      email,
      shippingAddress,
      shippingMethod,
      billingAddress,
      paymentMethod,
      cfToken,
    }: {
      email?: string;
      shippingAddress: ShippingAddress;
      shippingMethod: { carrier_code: string; method_code: string };
      billingAddress: ShippingAddress;
      paymentMethod: {
        method: string;
        additional_data?: Record<string, string>;
      };
      cfToken?: string;
    } = await request.json();

    if (!cfToken || !(await verifyTurnstile(cfToken))) {
      return NextResponse.json(
        { message: "Невалидна CAPTCHA. Опитайте отново." },
        { status: 400 },
      );
    }

    const headers: HeadersInit = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    // For authenticated users, verify the cookie cart belongs to them
    if (authToken) {
      const ownerResp = await fetch(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: print(Queries.GET_CUSTOMER_CART_ID) }),
      });
      const ownerData = await ownerResp.json();
      const customerCartId: string | undefined =
        ownerData.data?.customerCart?.id;
      if (customerCartId && customerCartId !== cartId) {
        return NextResponse.json({ message: "Cart mismatch" }, { status: 403 });
      }
    }

    // Always set guest email — even if authToken exists it may be stale/expired
    if (email) {
      const geResp = await fetch(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: print(Mutations.SET_GUEST_EMAIL_ON_CART),
          variables: { cartId, email },
        }),
      });
      const geData = await geResp.json();
      // For logged-in users this mutation will fail (not a guest cart) — ignore that specific error
      if (geData.errors && !authToken) {
        return NextResponse.json(
          { message: geData.errors[0]?.message ?? "Failed to set guest email" },
          { status: 400 },
        );
      }
    } else if (!authToken) {
      return NextResponse.json(
        { message: "Email is required" },
        { status: 400 },
      );
    }

    // Re-apply the user's real shipping address before placing
    const saResp = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: print(Mutations.SET_SHIPPING_ADDRESSES_ON_CART),
        variables: {
          cartId,
          firstname: shippingAddress.firstname,
          lastname: shippingAddress.lastname,
          street: Array.isArray(shippingAddress.street)
            ? shippingAddress.street
            : [shippingAddress.street],
          city: shippingAddress.city,
          region: shippingAddress.region,
          postcode: shippingAddress.postcode,
          country_code: shippingAddress.country_code,
          telephone: shippingAddress.telephone,
          // Carry the company invoice line on the shipping address too (matches
          // the legacy checkout, which sent the VAT on both addresses).
          company: shippingAddress.company?.trim() || null,
        },
      }),
    });
    const saData = await saResp.json();
    if (saData.errors) {
      return NextResponse.json(
        {
          message:
            saData.errors[0]?.message ?? "Failed to set shipping address",
        },
        { status: 400 },
      );
    }

    // Set shipping method
    const smResp = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: print(Mutations.SET_SHIPPING_METHOD_ON_CART),
        variables: {
          cartId,
          carrierCode: shippingMethod.carrier_code,
          methodCode: shippingMethod.method_code,
        },
      }),
    });
    const smData = await smResp.json();
    if (smData.errors) {
      return NextResponse.json(
        {
          message: smData.errors[0]?.message ?? "Failed to set shipping method",
        },
        { status: 400 },
      );
    }

    // Set billing address (always requires a full address object in Magento 2.3.7)
    const baResp = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: print(Mutations.SET_BILLING_ADDRESS_ON_CART),
        variables: {
          cartId,
          firstname: billingAddress.firstname,
          lastname: billingAddress.lastname,
          street: Array.isArray(billingAddress.street)
            ? billingAddress.street
            : [billingAddress.street],
          city: billingAddress.city,
          region: billingAddress.region,
          postcode: billingAddress.postcode,
          country_code: billingAddress.country_code,
          telephone: billingAddress.telephone,
          // Magento 2.3.7 GraphQL CartAddressInput has no vat_id field, so the
          // company invoice details (name + ЕИК/ДДС) are carried in `company`.
          company: billingAddress.company?.trim() || null,
        },
      }),
    });
    const baData = await baResp.json();
    if (baData.errors) {
      return NextResponse.json(
        {
          message: baData.errors[0]?.message ?? "Failed to set billing address",
        },
        { status: 400 },
      );
    }

    const isRevolut =
      paymentMethod.method === "revolut_pay" ||
      paymentMethod.method === "revolut_pay_later";
    const hasPublicId = !!paymentMethod.additional_data?.public_id;

    // The Revolut Magento module is incompatible with Pay 2.0 SDK. The card is
    // charged through Revolut's widget; in Magento we record the order under the
    // offline "banktransfer" method (titled "Платено с Revolut" in admin) as a
    // bridge, then auto-invoice via admin REST. Keeps card-paid orders distinct
    // from real cashondelivery orders.
    const placeAsMethod =
      isRevolut && hasPublicId ? "banktransfer" : paymentMethod.method;

    const pmResp = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: print(Mutations.SET_PAYMENT_METHOD_ON_CART),
        variables: { cartId, paymentCode: placeAsMethod },
      }),
    });
    const pmData = await pmResp.json();
    if (pmData.errors) {
      return NextResponse.json(
        {
          message: pmData.errors[0]?.message ?? "Failed to set payment method",
        },
        { status: 400 },
      );
    }

    const poResp = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: print(Mutations.PLACE_ORDER),
        variables: { cartId },
      }),
    });
    const poData = await poResp.json();
    if (poData.errors) {
      return NextResponse.json(
        { message: poData.errors[0]?.message ?? "Failed to place order" },
        { status: 400 },
      );
    }

    const orderNumber: string = poData.data?.placeOrder?.order?.order_number;
    if (!orderNumber) {
      return NextResponse.json(
        { message: "Order placed but no order number returned" },
        { status: 500 },
      );
    }

    cookieStore.delete("cart-id");

    // Link the Revolut order to this Magento order number via merchant_order_data.reference.
    // The webhook receives this back as `merchant_order_ext_ref`, letting it find and
    // invoice the order if the synchronous invoicing below is skipped or fails.
    if (isRevolut && hasPublicId && REVOLUT_API_SECRET_KEY) {
      const revolutOrderId = paymentMethod.additional_data?.order_id;
      const uuidRe =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (revolutOrderId && uuidRe.test(revolutOrderId)) {
        try {
          await fetch(`${REVOLUT_API_BASE}/orders/${revolutOrderId}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${REVOLUT_API_SECRET_KEY}`,
              "Revolut-Api-Version": "2024-09-01",
            },
            body: JSON.stringify({
              merchant_order_data: { reference: orderNumber },
            }),
          });
        } catch (e) {
          console.error("Failed to set Revolut merchant reference:", e);
        }
      }
    }

    // Post-order admin tasks (email + optional Revolut invoicing) — never block the response
    if (MAGENTO_ADMIN_USER && MAGENTO_ADMIN_PASSWORD) {
      try {
        // Get admin token
        const tokenResp = await fetch(`${REST_BASE}/integration/admin/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: MAGENTO_ADMIN_USER,
            password: MAGENTO_ADMIN_PASSWORD,
          }),
        });
        const adminToken: string = await tokenResp.json();

        if (typeof adminToken === "string" && tokenResp.ok) {
          const adminHeaders = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          };

          // Find order entity_id by increment_id
          const searchResp = await fetch(
            `${REST_BASE}/orders?searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=${orderNumber}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`,
            { headers: adminHeaders },
          );
          const searchData = await searchResp.json();
          const entityId: number | undefined =
            searchData?.items?.[0]?.entity_id;
          const magentoTotal: number | undefined =
            searchData?.items?.[0]?.grand_total;

          if (entityId) {
            // Always send order confirmation email (bypasses Magento async email queue)
            await fetch(`${REST_BASE}/orders/${entityId}/emails`, {
              method: "POST",
              headers: adminHeaders,
            });

            // Auto-invoice Revolut Pay orders so they show as paid in Magento admin
            if (isRevolut && hasPublicId) {
              const revolutOrderId = paymentMethod.additional_data?.order_id;

              // Verify Revolut order is completed/authorised before invoicing
              let canInvoice = false;
              if (revolutOrderId && REVOLUT_API_SECRET_KEY) {
                if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revolutOrderId)) {
                  canInvoice = false;
                } else {
                  const verifyResp = await fetch(
                    `${REVOLUT_API_BASE}/orders/${revolutOrderId}`,
                    {
                      headers: {
                        Authorization: `Bearer ${REVOLUT_API_SECRET_KEY}`,
                        "Revolut-Api-Version": "2024-09-01",
                      },
                    },
                  );
                  if (verifyResp.ok) {
                    const revolutOrder = await verifyResp.json();
                    const state: string = revolutOrder.state ?? "";
                    const stateOk = state === "completed" || state === "authorised";
                    const revolutAmountMinor: number | undefined = revolutOrder.order_amount?.value;
                    const amountOk =
                      magentoTotal === undefined ||
                      revolutAmountMinor === undefined ||
                      revolutAmountMinor === Math.round(magentoTotal * 100);
                    canInvoice = stateOk && amountOk;
                  } else {
                    canInvoice = false;
                  }
                }
              }

              if (canInvoice) {
                // Create invoice → marks order as paid
                await fetch(`${REST_BASE}/order/${entityId}/invoice`, {
                  method: "POST",
                  headers: adminHeaders,
                  body: JSON.stringify({ capture: true, notify: true }),
                });

                // Add order comment with Revolut Order ID (only UUID-safe values)
                const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                const rawCommentId = revolutOrderId || paymentMethod.additional_data?.public_id;
                const revolutCommentId = rawCommentId && uuidRe.test(rawCommentId) ? rawCommentId : null;
                if (revolutCommentId) {
                  await fetch(`${REST_BASE}/orders/${entityId}/comments`, {
                    method: "POST",
                    headers: adminHeaders,
                    body: JSON.stringify({
                      statusHistory: {
                        comment: `Платено чрез Revolut Pay. Revolut Order ID: ${revolutCommentId}`,
                        is_customer_notified: 0,
                        is_visible_on_front: 0,
                      },
                    }),
                  });
                }
              } else {
                console.error(
                  "Revolut order not authorised — skipping invoice",
                );
              }
            }
          }
        }
      } catch (e) {
        console.error("Post-order admin tasks failed:", e);
      }
    }

    return NextResponse.json({ orderNumber });
  } catch (error) {
    console.error("/api/checkout/place error:", error);
    return NextResponse.json(
      {
        message: error instanceof Error ? error.message : "Place order failed",
      },
      { status: 500 },
    );
  }
}
