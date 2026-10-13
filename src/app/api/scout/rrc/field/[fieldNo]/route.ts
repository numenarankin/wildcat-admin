import { notFoundUnlessPlatformAdmin } from "@/lib/auth/platform-admin";
import { getFieldProfile } from "@/lib/scout/rrc-queries";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ fieldNo: string }> }
) {
  const denied = await notFoundUnlessPlatformAdmin();
  if (denied) return denied;

  const { fieldNo } = await ctx.params;
  // RRC field numbers are 8 digits. Reject anything else here rather than
  // letting it reach the database: `getFieldProfile` validates against
  // rrc.field first precisely because a miss on field_cycle scans 11.2M rows.
  if (!/^\d{1,8}$/.test(fieldNo)) {
    return Response.json({ error: "bad field number" }, { status: 400 });
  }
  try {
    const profile = await getFieldProfile(fieldNo);
    if (!profile) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(profile);
  } catch (err) {
    console.error("[scout/rrc/field]", err);
    return Response.json({ error: "lookup failed" }, { status: 502 });
  }
}
