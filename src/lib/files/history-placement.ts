import type { SupabaseClient } from "@supabase/supabase-js";
import {
  placeInFacilityFolders,
  type FacilityKind,
} from "@/lib/files/facility-folder";
import type { UploadResult } from "@/lib/files/actions";

/**
 * A history document uploaded on one tank or meter can hold sections for
 * others (`uploadTankHistory` honours a row the source ties to a different
 * existing tank). The file is already in the page's own folder; this places
 * it in every OTHER device's folder the scan pinned rows to, so each device's
 * Files tab lists the document its history came from. Best-effort: a
 * placement failure never fails the upload that succeeded.
 */
export async function placeInOtherFacilities(
  sb: SupabaseClient,
  result: UploadResult,
  kind: "tank" | "meter",
  ownId: string
): Promise<void> {
  const fileId = result.files[0]?.id;
  if (!fileId) return;
  const others: { kind: FacilityKind; entityId: string }[] = [];
  for (const p of result.proposals) {
    const tankId = p.tankId;
    const meterId = p.meterId;
    if (tankId && !(kind === "tank" && tankId === ownId)) {
      others.push({ kind: "tank", entityId: tankId });
    }
    if (meterId && !(kind === "meter" && meterId === ownId)) {
      others.push({ kind: "meter", entityId: meterId });
    }
  }
  if (others.length === 0) return;
  try {
    await placeInFacilityFolders(sb, fileId, others);
  } catch (error) {
    console.error(`placeInOtherFacilities(${kind} ${ownId})`, error);
  }
}
