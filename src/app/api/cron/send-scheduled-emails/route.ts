import { getSupabaseAdmin } from "@/lib/supabase/server";
import { sendDueScheduledEmails } from "@/lib/admin/outreach/send-scheduled";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Every five minutes (vercel.json): send the scheduled outreach emails whose
 * time has come, each through the Gmail of the admin who scheduled it.
 * Gmail's API cannot schedule a send, so this is the scheduler. Verifies
 * `CRON_SECRET` the way the customer app's crons do.
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const report = await sendDueScheduledEmails(getSupabaseAdmin());
    if (report.failed.length) console.error("[cron/send-scheduled-emails] failures", report.failed);
    return Response.json({ sent: report.sent.length, failed: report.failed.length });
  } catch (err) {
    console.error("[cron/send-scheduled-emails]", err);
    return Response.json({ error: "send failed" }, { status: 500 });
  }
}
