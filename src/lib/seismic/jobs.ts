import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin, getSupabaseServer } from "@/lib/supabase/server";
import { computeCreditsForUsd } from "@/lib/billing/credits";

/**
 * Reads and writes of `seismic_jobs` (migration 2026091600600).
 *
 * Contract: docs/plans/seismic.md, "## Design: app integration" > "### Jobs"
 * and "### Callback". Reads for the viewer and Orion go through the caller's
 * RLS-scoped client; every write goes through the service role, because the
 * table has no client write policy.
 */

export type SeismicJobStatus = "queued" | "running" | "done" | "failed";

/** A job in one of these can still change. The unique index keys off the same pair. */
export const SEISMIC_ACTIVE_STATUSES = ["queued", "running"] as const;

/** Bucket for the volume and every output ("### Files and routing"). */
export const SEISMIC_BUCKET = "files";

/** The five worker outputs, named as the dispatch payload's `outputs` keys. */
export const SEISMIC_OUTPUT_FILES = [
  "brief.json",
  "cube.json",
  "cube.bin",
  "horizons.json",
  "horizons.bin",
] as const;
export type SeismicOutputFile = (typeof SEISMIC_OUTPUT_FILES)[number];

/** `.sgy` / `.segy`, the routing test every surface uses. */
export const SEISMIC_FILE_PATTERN = /\.(sgy|segy)$/i;

export interface SeismicJob {
  id: string;
  org_id: string;
  file_id: string;
  created_by: string | null;
  status: SeismicJobStatus;
  stage: string | null;
  progress: Record<string, unknown>;
  output_prefix: string | null;
  brief_key: string | null;
  cube_key: string | null;
  horizons_key: string | null;
  error: string | null;
  gpu_seconds: number | null;
  cost_usd: number | null;
  credits: number | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const JOB_COLUMNS =
  "id, org_id, file_id, created_by, status, stage, progress, output_prefix, brief_key, cube_key, horizons_key, error, gpu_seconds, cost_usd, credits, last_event_at, created_at, updated_at, finished_at";

/** `seismic/<file_id>/<job_id>/`, where all of a job's outputs live. */
export function seismicOutputPrefix(fileId: string, jobId: string): string {
  return `seismic/${fileId}/${jobId}/`;
}

export type SignSeismicOutputUploadsResult =
  | { ok: true; outputs: Record<SeismicOutputFile, string> }
  | { ok: false; name: SeismicOutputFile; message: string };

/**
 * Signed upload URLs for all five outputs under `seismic/<file_id>/<job_id>/`.
 *
 * The one place the set is minted: the dispatch payload carries the first set
 * and every 2xx callback response a fresh one ("### Callback"), because a
 * signed upload URL lives two hours and a large job runs longer. `upsert`
 * because the worker publishes progressively, so brief.json is written more
 * than once as stages land.
 */
export async function signSeismicOutputUploads(
  admin: SupabaseClient,
  fileId: string,
  jobId: string
): Promise<SignSeismicOutputUploadsResult> {
  const prefix = seismicOutputPrefix(fileId, jobId);
  const storage = admin.storage.from(SEISMIC_BUCKET);
  const signed = await Promise.all(
    SEISMIC_OUTPUT_FILES.map(async (name) => {
      const { data, error } = await storage.createSignedUploadUrl(`${prefix}${name}`, {
        upsert: true,
      });
      return { name, url: data?.signedUrl ?? null, error: error?.message ?? null };
    })
  );
  const outputs = {} as Record<SeismicOutputFile, string>;
  for (const { name, url, error } of signed) {
    if (!url) return { ok: false, name, message: error ?? "no URL" };
    outputs[name] = url;
  }
  return { ok: true, outputs };
}

// --- Reads (RLS) ------------------------------------------------------------

/**
 * The newest job for a volume, or null when it has never been digitized (or
 * the caller cannot see the file: the read policy is the file's own).
 *
 * `status: "done"` asks for the newest SUCCESSFUL job, which is what Orion's
 * `read_seismic_brief` prefers before falling back to the newest job's partial
 * brief. Pass `client` to reuse a request's RLS client; the default is the
 * signed-in user's.
 */
export async function getLatestSeismicJob(
  fileId: string,
  opts: { status?: SeismicJobStatus; client?: SupabaseClient } = {}
): Promise<SeismicJob | null> {
  const sb = opts.client ?? (await getSupabaseServer());
  let query = sb
    .from("seismic_jobs")
    .select(JOB_COLUMNS)
    .eq("file_id", fileId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (opts.status) query = query.eq("status", opts.status);
  const { data, error } = await query.maybeSingle<SeismicJob>();
  if (error) throw new Error(`getLatestSeismicJob: ${error.message}`);
  return data ?? null;
}

/**
 * Signed GET URLs for whichever outputs of `job` exist, keyed by output file
 * name (`urls["cube.bin"]`). An output that has not landed is absent.
 *
 * `cube_key` and `horizons_key` each name one half of a json + bin pair; both
 * halves are derived from it (same stem, `.json` and `.bin`) and each is
 * included only if the object exists.
 *
 * Signed with the service role, so the CALLER must have read `job` through RLS
 * ({@link getLatestSeismicJob}); never pass a job row read with the admin
 * client on behalf of a user.
 */
export async function seismicOutputUrls(
  job: Pick<SeismicJob, "brief_key" | "cube_key" | "horizons_key">,
  expiresInSeconds = 60 * 60
): Promise<Partial<Record<SeismicOutputFile, string>>> {
  const wanted: [SeismicOutputFile, string][] = [];
  if (job.brief_key) wanted.push(["brief.json", job.brief_key]);
  if (job.cube_key) {
    wanted.push(["cube.json", withExtension(job.cube_key, ".json")]);
    wanted.push(["cube.bin", withExtension(job.cube_key, ".bin")]);
  }
  if (job.horizons_key) {
    wanted.push(["horizons.json", withExtension(job.horizons_key, ".json")]);
    wanted.push(["horizons.bin", withExtension(job.horizons_key, ".bin")]);
  }
  if (wanted.length === 0) return {};

  const { data, error } = await getSupabaseAdmin()
    .storage.from(SEISMIC_BUCKET)
    .createSignedUrls(
      wanted.map(([, key]) => key),
      expiresInSeconds
    );
  if (error) throw new Error(`seismicOutputUrls: ${error.message}`);

  const byKey = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.path && row.signedUrl && !row.error) byKey.set(row.path, row.signedUrl);
  }
  const out: Partial<Record<SeismicOutputFile, string>> = {};
  for (const [name, key] of wanted) {
    const url = byKey.get(key);
    if (url) out[name] = url;
  }
  return out;
}

/** `a/cube.json` -> `a/cube.bin`; a key with no extension gets one appended. */
function withExtension(key: string, ext: ".json" | ".bin"): string {
  return key.replace(/\.(json|bin)$/i, "") + ext;
}

// --- Writes (service role) --------------------------------------------------

export type InsertSeismicJobResult =
  | { ok: true; job: SeismicJob }
  | { ok: false; reason: "active_job_exists"; activeJobId: string | null }
  | { ok: false; reason: "error"; message: string };

/** Insert a `queued` job. A second active job for the file is refused by the index. */
export async function insertSeismicJob(
  admin: SupabaseClient,
  row: { id: string; org_id: string; file_id: string; created_by: string }
): Promise<InsertSeismicJobResult> {
  const { data, error } = await admin
    .from("seismic_jobs")
    .insert({
      ...row,
      status: "queued",
      output_prefix: seismicOutputPrefix(row.file_id, row.id),
    })
    .select(JOB_COLUMNS)
    .single<SeismicJob>();
  if (!error && data) return { ok: true, job: data };
  if (error?.code === "23505") {
    const { data: active } = await admin
      .from("seismic_jobs")
      .select("id")
      .eq("file_id", row.file_id)
      .in("status", [...SEISMIC_ACTIVE_STATUSES])
      .maybeSingle<{ id: string }>();
    return { ok: false, reason: "active_job_exists", activeJobId: active?.id ?? null };
  }
  return { ok: false, reason: "error", message: error?.message ?? "insert returned no row" };
}

/**
 * Mark a job that never reached the worker as failed, with the reason the user
 * will see. Conditional on it still being active, so it cannot overwrite a
 * result the worker already reported.
 */
export async function failSeismicJob(
  admin: SupabaseClient,
  jobId: string,
  reason: string
): Promise<void> {
  const { error } = await admin
    .from("seismic_jobs")
    .update({ status: "failed", error: reason, finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", [...SEISMIC_ACTIVE_STATUSES]);
  if (error) console.error("failSeismicJob:", error.message);
}

// --- Worker events ----------------------------------------------------------

/** The callback body ("### Callback"), validated. */
export interface SeismicEvent {
  job_id: string;
  event: "stage" | "done" | "failed";
  stage: string | null;
  progress: Record<string, unknown> | null;
  keys: { brief?: string; cube?: string; horizons?: string };
  gpu_seconds: number | null;
  cost_usd: number | null;
  error: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Validate a parsed callback body. Returns the event, or a reason string. */
export function parseSeismicEvent(body: unknown): SeismicEvent | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body is not an object";
  const b = body as Record<string, unknown>;
  if (typeof b.job_id !== "string" || !UUID.test(b.job_id)) return "job_id is not a uuid";
  if (b.event !== "stage" && b.event !== "done" && b.event !== "failed") {
    return "event must be stage, done or failed";
  }
  const progress =
    b.progress && typeof b.progress === "object" && !Array.isArray(b.progress)
      ? (b.progress as Record<string, unknown>)
      : null;
  const keys: SeismicEvent["keys"] = {};
  if (b.keys && typeof b.keys === "object" && !Array.isArray(b.keys)) {
    const k = b.keys as Record<string, unknown>;
    for (const name of ["brief", "cube", "horizons"] as const) {
      if (typeof k[name] === "string" && k[name]) keys[name] = k[name] as string;
    }
  }
  return {
    job_id: b.job_id,
    event: b.event,
    stage: typeof b.stage === "string" && b.stage ? b.stage : null,
    progress,
    keys,
    gpu_seconds: finiteOrNull(b.gpu_seconds),
    cost_usd: finiteOrNull(b.cost_usd),
    error: typeof b.error === "string" && b.error ? b.error : null,
  };
}

export type ApplySeismicEventResult =
  | { kind: "not_found" }
  /** `t` is older than the job's `last_event_at`. */
  | { kind: "replay" }
  /** A key points outside this job's output prefix. */
  | { kind: "bad_key"; key: string }
  /** The job is already done or failed; nothing changed, nothing to bill. */
  | { kind: "ignored"; job: SeismicJob }
  /** Lost the race to concurrent events for the same job, three times. */
  | { kind: "conflict" }
  /**
   * The update changed the row. `transitioned` is set only for the event that
   * moved the job to done/failed: the ONE place credits are metered and the
   * ready/failed notification is sent.
   */
  | { kind: "applied"; job: SeismicJob; transitioned: "done" | "failed" | null };

const MAX_EVENT_ATTEMPTS = 3;

/**
 * Apply one verified worker event (signed at unix second `t`).
 *
 * Every write is a single conditional update: `status in ('queued','running')`
 * AND `updated_at` still what was read. The status condition is what makes
 * terminal events idempotent (a second `done` matches no row, so it is never
 * billed twice); the `updated_at` condition makes concurrent events serialize
 * instead of one merging `progress` over a stale copy. It is `updated_at` and
 * not `last_event_at` because two events in the same second leave
 * `last_event_at` unchanged, so it cannot tell a concurrent write happened;
 * the `set_updated_at` trigger moves `updated_at` on every write. A lost race
 * re-reads and re-checks the replay guard.
 */
export async function applySeismicEvent(
  admin: SupabaseClient,
  event: SeismicEvent,
  t: number
): Promise<ApplySeismicEventResult> {
  for (let attempt = 0; attempt < MAX_EVENT_ATTEMPTS; attempt++) {
    const { data: job, error: readErr } = await admin
      .from("seismic_jobs")
      .select(JOB_COLUMNS)
      .eq("id", event.job_id)
      .maybeSingle<SeismicJob>();
    if (readErr) throw new Error(`applySeismicEvent (read): ${readErr.message}`);
    if (!job) return { kind: "not_found" };

    // Older is a replay; equal is accepted. `t` is whole seconds, so two real
    // events can share one ("### Callback").
    if (job.last_event_at) {
      const lastT = Math.floor(Date.parse(job.last_event_at) / 1000);
      if (t < lastT) return { kind: "replay" };
    }
    if (job.status === "done" || job.status === "failed") {
      return { kind: "ignored", job };
    }

    const prefix = job.output_prefix ?? seismicOutputPrefix(job.file_id, job.id);
    for (const key of Object.values(event.keys)) {
      if (!key.startsWith(prefix) || key.includes("..")) return { kind: "bad_key", key };
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      last_event_at: new Date(t * 1000).toISOString(),
      // The trigger overwrites this with now(); set here too so the write moves
      // it even where no trigger runs.
      updated_at: now,
      progress: { ...(job.progress ?? {}), ...(event.progress ?? {}) },
    };
    if (event.stage) patch.stage = event.stage;
    if (event.keys.brief) patch.brief_key = event.keys.brief;
    if (event.keys.cube) patch.cube_key = event.keys.cube;
    if (event.keys.horizons) patch.horizons_key = event.keys.horizons;
    if (event.gpu_seconds !== null) patch.gpu_seconds = event.gpu_seconds;
    if (event.cost_usd !== null) patch.cost_usd = event.cost_usd;

    if (event.event === "stage") {
      patch.status = "running";
    } else if (event.event === "done") {
      patch.status = "done";
      patch.finished_at = now;
      patch.credits = computeCreditsForUsd(event.cost_usd ?? 0);
    } else {
      patch.status = "failed";
      patch.finished_at = now;
      patch.error = event.error ?? "The analysis failed without a reason from the worker.";
      // "A failed job is not charged."
      patch.credits = 0;
    }

    const { data: changed, error: updErr } = await admin
      .from("seismic_jobs")
      .update(patch)
      .eq("id", job.id)
      .in("status", [...SEISMIC_ACTIVE_STATUSES])
      .eq("updated_at", job.updated_at)
      .select(JOB_COLUMNS);
    if (updErr) throw new Error(`applySeismicEvent (update): ${updErr.message}`);

    const row = (changed as SeismicJob[] | null)?.[0];
    if (row) {
      return {
        kind: "applied",
        job: row,
        transitioned: event.event === "stage" ? null : event.event,
      };
    }
    // No row changed: another event landed between the read and the update.
  }
  return { kind: "conflict" };
}
