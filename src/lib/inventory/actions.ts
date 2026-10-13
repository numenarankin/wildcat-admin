"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { InventoryItem } from "@/lib/inventory/inventory";

export type InventoryInput = Omit<InventoryItem, "id">;

function toRow(input: InventoryInput) {
  return {
    name: input.name,
    category: input.category || null,
    quantity: input.quantity,
    unit: input.unit || null,
    location: input.location || null,
    unit_cost: input.unitCost,
    status: input.status,
    description: input.description || null,
  };
}

/** Create an inventory item. */
export async function createInventoryItem(
  input: InventoryInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("inventory_items").insert(toRow(input));
  if (error) throw new Error(`createInventoryItem: ${error.message}`);
  revalidatePath("/inventory");
}

/** Update an inventory item. */
export async function updateInventoryItem(
  id: string,
  input: InventoryInput
): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb
    .from("inventory_items")
    .update(toRow(input))
    .eq("id", id);
  if (error) throw new Error(`updateInventoryItem: ${error.message}`);
  revalidatePath("/inventory");
}

/** Delete an inventory item. */
export async function deleteInventoryItem(id: string): Promise<void> {
  const sb = await getSupabaseServer();
  const { error } = await sb.from("inventory_items").delete().eq("id", id);
  if (error) throw new Error(`deleteInventoryItem: ${error.message}`);
  revalidatePath("/inventory");
}
