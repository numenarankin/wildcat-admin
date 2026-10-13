"use server";

import { revalidatePath } from "next/cache";
import { requireGoogleAdminId } from "@/lib/admin/google/guard";
import { GoogleApiError, googleErrorMessage } from "@/lib/admin/google/fetch";
import { deleteEvent, insertEvent, patchEvent } from "@/lib/admin/google/calendar/client";
import type {
  CalendarActionResult,
  GoogleAttendee,
  GoogleEventDateTime,
  GoogleEventInput,
  GoogleEventRef,
} from "@/lib/admin/google/calendar/types";

/**
 * Calendar writes from /admin/calendar. Each one starts at the session's admin
 * id (a non-admin gets "Not found." before any Google call) and answers with a
 * result rather than a throw, so the page can show Google's reason.
 */

const PATH = "/calendar";
const STALE_EVENT = "This event changed in Google. It has been reloaded.";

function failure(error: unknown, action: string): CalendarActionResult {
  if (error instanceof GoogleApiError && error.status === 412) {
    return { ok: false, error: STALE_EVENT, stale: true };
  }
  console.error(`${action} failed`, error);
  return { ok: false, error: googleErrorMessage(error, "Calendar") };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function when(value: GoogleEventDateTime | undefined): GoogleEventDateTime | undefined {
  if (!value) return undefined;
  const out: GoogleEventDateTime = {};
  for (const k of ["date", "dateTime", "timeZone"] as const) {
    if (value[k] === null) out[k] = null;
    else if (typeof value[k] === "string") out[k] = value[k];
  }
  return out;
}

/** Only the fields this page edits reach Google. */
function clean(input: GoogleEventInput): GoogleEventInput {
  const out: GoogleEventInput = {};
  if (str(input.summary) !== undefined) out.summary = input.summary;
  if (str(input.location) !== undefined) out.location = input.location;
  if (str(input.description) !== undefined) out.description = input.description;
  const start = when(input.start);
  const end = when(input.end);
  if (start) out.start = start;
  if (end) out.end = end;
  if (Array.isArray(input.attendees)) {
    out.attendees = input.attendees
      .filter((a): a is GoogleAttendee => typeof a?.email === "string" && a.email.trim() !== "")
      .map((a) => ({ ...a, email: a.email.trim() }));
  }
  return out;
}

function cleanRef(ref: GoogleEventRef): GoogleEventRef {
  return {
    calendarId: String(ref.calendarId),
    eventId: String(ref.eventId),
    etag: String(ref.etag),
    hasAttendees: ref.hasAttendees === true,
  };
}

export async function createGoogleEvent(
  calendarId: string,
  input: GoogleEventInput
): Promise<CalendarActionResult> {
  const userId = await requireGoogleAdminId();
  try {
    await insertEvent(userId, String(calendarId), clean(input));
    return { ok: true };
  } catch (error) {
    return failure(error, "createGoogleEvent");
  } finally {
    revalidatePath(PATH);
  }
}

export async function updateGoogleEvent(
  ref: GoogleEventRef,
  input: GoogleEventInput
): Promise<CalendarActionResult> {
  const userId = await requireGoogleAdminId();
  try {
    await patchEvent(userId, cleanRef(ref), clean(input));
    return { ok: true };
  } catch (error) {
    return failure(error, "updateGoogleEvent");
  } finally {
    revalidatePath(PATH);
  }
}

export async function deleteGoogleEvent(ref: GoogleEventRef): Promise<CalendarActionResult> {
  const userId = await requireGoogleAdminId();
  try {
    await deleteEvent(userId, cleanRef(ref));
    return { ok: true };
  } catch (error) {
    return failure(error, "deleteGoogleEvent");
  } finally {
    revalidatePath(PATH);
  }
}
