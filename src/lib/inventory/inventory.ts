import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";

/** Stock status for an inventory item. */
export type InventoryStatus = "In Stock" | "Low" | "On Order";

/**
 * A material or part held in the operator's yards / warehouses.
 */
export interface InventoryItem {
  id: string;
  /** Item description. */
  name: string;
  /** Category, e.g. "Tubulars", "Pumps", "Chemicals". */
  category: string;
  /** Quantity on hand. */
  quantity: number;
  /** Unit of measure, e.g. "ea", "ft", "joint", "drum". */
  unit: string;
  /** Storage location. */
  location: string;
  /** Cost per unit, in US dollars. */
  unitCost: number;
  status: InventoryStatus;
  /** Free-form notes / longer description of the item. */
  description: string;
}

interface InventoryRow {
  id: string;
  name: string;
  category: string | null;
  quantity: number | null;
  unit: string | null;
  location: string | null;
  unit_cost: number | null;
  status: InventoryStatus;
  description: string | null;
}

function mapItem(r: InventoryRow): InventoryItem {
  return {
    id: r.id,
    name: r.name,
    category: r.category ?? "",
    quantity: r.quantity ?? 0,
    unit: r.unit ?? "",
    location: r.location ?? "",
    unitCost: r.unit_cost ?? 0,
    status: r.status,
    description: r.description ?? "",
  };
}

/** Returns the inventory items, ordered by name. */
export async function getInventory(): Promise<InventoryItem[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("inventory_items")
    .select(
      "id, name, category, quantity, unit, location, unit_cost, status, description"
    )
    .order("name");
  if (error) throw new Error(`getInventory: ${error.message}`);
  return ((data ?? []) as InventoryRow[]).map(mapItem);
}
