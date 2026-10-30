"use server";

import { revalidatePath } from "next/cache";
import { assertAdminPage } from "@/lib/auth/platform-admin";
import { cancelBooking } from "./cancel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Bookings page's cancel, behind the page's own access. */
export async function cancelBookingAction(id: string): Promise<{ calendar: boolean; email: boolean }> {
  await assertAdminPage("bookings");
  if (!UUID.test(id)) throw new Error("Unknown booking.");
  const result = await cancelBooking(id);
  revalidatePath("/bookings");
  return result;
}
