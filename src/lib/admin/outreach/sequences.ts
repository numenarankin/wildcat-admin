import "server-only";
import { hasSupabase } from "@/lib/env";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getOperatorsP5 } from "@/lib/scout/queries";
import { fmtPhone } from "@/lib/scout/format";
import {
  compareDue,
  DEFAULT_SEQUENCE_STEPS,
  type Enrollment,
  type EnrollmentState,
  type Sequence,
  type SequenceAction,
  type SequenceStep,
} from "@/lib/admin/outreach/types";

/**
 * The Sequence tab's reads (`admin_sequences`, `admin_sequence_enrollments`,
 * `admin_sequence_events`, migration 2026100800400). Request-scoped client.
 */

interface SequenceRow {
  id: string;
  name: string;
  steps: SequenceStep[] | null;
}

interface EnrollmentRow {
  id: string;
  operator_no: number;
  contact_id: string | null;
  sequence_id: string;
  step_index: number;
  next_due_on: string | null;
  state: EnrollmentState;
  enrolled_on: string;
  admin_targets: { name: string };
  admin_target_contacts: { id: string; name: string | null; email: string | null; phone: string | null } | null;
}

interface EventRow {
  enrollment_id: string;
  action: SequenceAction;
  outcome: string;
  happened_at: string;
}

function validSteps(steps: unknown): SequenceStep[] {
  if (!Array.isArray(steps)) return DEFAULT_SEQUENCE_STEPS;
  const ok = steps.every(
    (s) =>
      s &&
      typeof s === "object" &&
      typeof (s as SequenceStep).round === "number" &&
      typeof (s as SequenceStep).weekday === "number" &&
      ((s as SequenceStep).action === "email" || (s as SequenceStep).action === "call")
  );
  return ok && steps.length > 0 ? (steps as SequenceStep[]) : DEFAULT_SEQUENCE_STEPS;
}

/** The cadence named Default (seeded by the migration), else the built-in steps. */
export async function getDefaultSequence(): Promise<Sequence | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_sequences")
    .select("id, name, steps")
    .eq("name", "Default")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<SequenceRow>();
  if (error) throw new Error(`getDefaultSequence: ${error.message}`);
  return data ? { id: data.id, name: data.name, steps: validSteps(data.steps) } : null;
}

export async function getSequence(id: string): Promise<Sequence | null> {
  if (!hasSupabase()) return null;
  const sb = await getSupabaseServer();
  const { data, error } = await sb.from("admin_sequences").select("id, name, steps").eq("id", id).maybeSingle<SequenceRow>();
  if (error) throw new Error(`getSequence: ${error.message}`);
  return data ? { id: data.id, name: data.name, steps: validSteps(data.steps) } : null;
}

/** Every enrollment, due first, with the company, the contact and the last event. */
export async function getEnrollments(): Promise<Enrollment[]> {
  if (!hasSupabase()) return [];
  const sb = await getSupabaseServer();
  const { data, error } = await sb
    .from("admin_sequence_enrollments")
    .select(
      "id, operator_no, contact_id, sequence_id, step_index, next_due_on, state, enrolled_on, admin_targets!inner(name), admin_target_contacts(id, name, email, phone)"
    );
  if (error) throw new Error(`getEnrollments: ${error.message}`);
  const rows = (data ?? []) as unknown as EnrollmentRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const { data: events, error: evErr } = await sb
    .from("admin_sequence_events")
    .select("enrollment_id, action, outcome, happened_at")
    .in("enrollment_id", ids)
    .order("happened_at", { ascending: false });
  if (evErr) throw new Error(`getEnrollments (events): ${evErr.message}`);
  const lastEvent = new Map<string, EventRow>();
  for (const e of (events ?? []) as EventRow[]) if (!lastEvent.has(e.enrollment_id)) lastEvent.set(e.enrollment_id, e);

  // The company phone for a call step: the P-5's, through the same read the
  // cluster CSV uses.
  const nums = [...new Set(rows.map((r) => r.operator_no))];
  const p5 = await getOperatorsP5(nums).catch(() => new Map<number, { phone: number | null }>());

  return rows
    .map((r) => {
      const ev = lastEvent.get(r.id);
      return {
        id: r.id,
        operatorNo: r.operator_no,
        companyName: r.admin_targets.name,
        contact: r.admin_target_contacts
          ? {
              id: r.admin_target_contacts.id,
              name: r.admin_target_contacts.name,
              email: r.admin_target_contacts.email,
              phone: r.admin_target_contacts.phone,
            }
          : null,
        companyPhone: fmtPhone(p5.get(r.operator_no)?.phone) ?? null,
        sequenceId: r.sequence_id,
        stepIndex: r.step_index,
        nextDueOn: r.next_due_on,
        state: r.state,
        enrolledOn: r.enrolled_on,
        lastEvent: ev ? { action: ev.action, outcome: ev.outcome, happenedAt: ev.happened_at } : null,
      };
    })
    .sort(compareDue);
}
