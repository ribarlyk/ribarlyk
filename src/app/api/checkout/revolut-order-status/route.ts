import { NextResponse } from "next/server";

const REVOLUT_API_SECRET_KEY = process.env.REVOLUT_API_SECRET_KEY ?? "";
const REVOLUT_ENV = process.env.NEXT_PUBLIC_REVOLUT_ENV ?? "sandbox";
const REVOLUT_API_BASE =
  REVOLUT_ENV === "sandbox"
    ? "https://sandbox-merchant.revolut.com/api"
    : "https://merchant.revolut.com/api";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lets the checkout poll a Revolut order's state. Used as a fallback when the
// SDK's onSuccess callback never fires after a 3DS challenge — the client polls
// here, and once the order is `authorised`/`completed` it places the order
// instead of spinning on "Обработва се…" forever.
export async function GET(request: Request) {
  if (!REVOLUT_API_SECRET_KEY) {
    return NextResponse.json(
      { message: "Revolut API key not configured" },
      { status: 500 },
    );
  }

  const orderId = new URL(request.url).searchParams.get("orderId") ?? "";
  if (!UUID_RE.test(orderId)) {
    return NextResponse.json({ message: "Invalid order id" }, { status: 400 });
  }

  try {
    const resp = await fetch(`${REVOLUT_API_BASE}/orders/${orderId}`, {
      headers: {
        Authorization: `Bearer ${REVOLUT_API_SECRET_KEY}`,
        "Revolut-Api-Version": "2024-09-01",
      },
      cache: "no-store",
    });

    if (!resp.ok) {
      return NextResponse.json(
        { message: "Could not fetch order" },
        { status: 502 },
      );
    }

    const order = await resp.json();
    return NextResponse.json({ state: order.state ?? null });
  } catch (error) {
    console.error("/api/checkout/revolut-order-status error:", error);
    return NextResponse.json({ message: "Error" }, { status: 500 });
  }
}
