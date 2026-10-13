import "server-only";

import { getLatestSeismicJob, seismicOutputUrls } from "@/lib/seismic/jobs";

/**
 * What `read_seismic_brief` hands Orion (`docs/plans/seismic.md`, "Orion").
 *
 * The brief is the worker's rendered `brief.json` (contract 11's `render_brief`:
 * compact JSON, already trimmed to its token budget and saying so in
 * `meta.budget`). It is passed through as text, unaltered, because every number
 * Orion states has to trace back to a field in it.
 *
 * Absence is said, never implied: a product the pipeline could not compute
 * arrives in the brief's own `absent` map with its reason, and an output the
 * job has not published (still running, failed, never started) is added here
 * with the reason this layer knows.
 */

export type SeismicBriefStatus = "none" | "queued" | "running" | "done" | "failed";

export interface SeismicBriefResult {
  fileId: string;
  status: SeismicBriefStatus;
  jobId: string | null;
  /** Last stage the worker published. */
  stage: string | null;
  finishedAt: string | null;
  error: string | null;
  /** The rendered brief, or null when none has been published. */
  brief: string | null;
  /** `{ product: reason }`: the brief's own absences plus what is unpublished. */
  absent: Record<string, string>;
  /** Per-stage `ran | skipped | failed` + seconds, as the worker reported it. */
  stages: unknown;
  /** One plain sentence on what this result is. */
  note: string;
}

/** A brief larger than this is a malformed file, not a brief (the budget is 45,000 chars). */
const MAX_BRIEF_CHARS = 120_000;

function briefAbsences(text: string): Record<string, string> {
  try {
    const parsed = JSON.parse(text) as { absent?: unknown };
    if (!parsed.absent || typeof parsed.absent !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.absent as Record<string, unknown>)) {
      out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

export async function readSeismicBrief(fileId: string): Promise<SeismicBriefResult> {
  // The newest successful analysis first; otherwise the newest job, whatever
  // state it is in, with whatever it has published so far.
  const job =
    (await getLatestSeismicJob(fileId, { status: "done" })) ??
    (await getLatestSeismicJob(fileId));
  if (!job) {
    return {
      fileId,
      status: "none",
      jobId: null,
      stage: null,
      finishedAt: null,
      error: null,
      brief: null,
      absent: { brief: "no analysis has been run on this volume" },
      stages: null,
      note:
        "No analysis exists for this volume. Nothing about it has been computed; the user can start one with Digitize in the seismic viewer.",
    };
  }

  const status: SeismicBriefStatus = job.status;
  const base = {
    fileId,
    status,
    jobId: job.id,
    stage: job.stage,
    finishedAt: job.finished_at,
    error: job.error,
    stages: job.progress,
  };

  const url = (await seismicOutputUrls(job))["brief.json"] ?? null;
  let brief: string | null = null;
  let fetchFailure: string | null = null;
  if (url) {
    try {
      const res = await fetch(url);
      if (!res.ok) fetchFailure = `brief.json could not be downloaded (HTTP ${res.status})`;
      else {
        const text = await res.text();
        if (text.length > MAX_BRIEF_CHARS) {
          fetchFailure = `brief.json is ${text.length} characters, over the ${MAX_BRIEF_CHARS} a brief can be`;
        } else brief = text;
      }
    } catch (err) {
      fetchFailure = `brief.json could not be downloaded (${err instanceof Error ? err.message : String(err)})`;
    }
  }

  const absent: Record<string, string> = brief ? briefAbsences(brief) : {};
  const stageWords = job.stage ? ` (last stage published: ${job.stage})` : "";

  if (!brief) {
    absent.brief =
      fetchFailure ??
      (status === "failed"
        ? `the analysis failed before a brief was published: ${job.error ?? "no reason recorded"}`
        : status === "done"
          ? "the analysis finished without publishing a brief"
          : `the analysis is ${status}${stageWords}; the brief is published when its stages finish`);
  }

  let note: string;
  if (status === "done") {
    note = brief
      ? "The analysis is complete. Answer from the brief's numbers and state the uncertainty that travels with them."
      : `The analysis is complete but its brief is unavailable: ${absent.brief}.`;
  } else if (status === "failed") {
    note = brief
      ? `The analysis failed (${job.error ?? "no reason recorded"}); this is the partial brief it published first. Anything not in it was not computed.`
      : `The analysis failed: ${job.error ?? "no reason recorded"}. No brief exists.`;
  } else {
    note = brief
      ? `The analysis is still ${status}${stageWords}; this brief is partial and products may still land.`
      : `The analysis is ${status}${stageWords}; no brief has been published yet.`;
  }

  return { ...base, brief, absent, note };
}
