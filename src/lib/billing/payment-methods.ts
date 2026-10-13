import "server-only";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getStripe } from "@/lib/billing/stripe";
import { hasStripe, hasSupabase } from "@/lib/env";

/** A card on file for the org, shaped for the billing table + edit modal. */
export interface PaymentMethodInfo {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  name: string | null;
  isDefault: boolean;
}

/** List the current org's saved cards (RLS-scoped customer lookup → Stripe). */
export async function getPaymentMethods(): Promise<PaymentMethodInfo[]> {
  if (!hasStripe() || !hasSupabase()) return [];
  try {
    const sb = await getSupabaseServer();
    const { data: sub } = await sb
      .from("subscriptions")
      .select("stripe_customer_id")
      .maybeSingle<{ stripe_customer_id: string | null }>();
    const customerId = sub?.stripe_customer_id;
    if (!customerId) return [];

    const stripe = getStripe();
    const [customer, pms] = await Promise.all([
      stripe.customers.retrieve(customerId),
      stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 20 }),
    ]);

    const def =
      !customer.deleted && customer.invoice_settings?.default_payment_method;
    const defaultId = def
      ? typeof def === "string"
        ? def
        : def.id
      : null;

    return pms.data
      .filter((pm) => pm.card)
      .map((pm) => ({
        id: pm.id,
        brand: pm.card!.brand,
        last4: pm.card!.last4,
        expMonth: pm.card!.exp_month,
        expYear: pm.card!.exp_year,
        name: pm.billing_details?.name ?? null,
        isDefault: pm.id === defaultId,
      }));
  } catch (error) {
    console.error("getPaymentMethods failed", error);
    return [];
  }
}
