"use server";

/**
 * Server actions for the Recon alerts modal.
 *
 * Every action starts with `assertPlatformAdmin()`; RLS (`recon_alerts_own`) is the
 * real boundary and limits each call to the caller's own alerts in the org
 * they are signed into.
 */

import { assertPlatformAdmin } from "@/lib/auth/platform-admin";
import {
  cleanInput,
  createAlert,
  deleteAlert,
  getMyAlert,
  listMyAlerts,
  updateAlert,
} from "./data";
import { latestArrivalRun } from "./arrivals";
import type { ReconAlert, ReconAlertInput } from "./types";

export async function listReconAlerts(): Promise<ReconAlert[]> {
  await assertPlatformAdmin();
  return listMyAlerts();
}

/** The counties an alert watches, for opening Recon on them (`?alert=`). */
export async function getReconAlertCounties(id: string): Promise<number[] | null> {
  await assertPlatformAdmin();
  return (await getMyAlert(id))?.countyCodes ?? null;
}

/** Create (no id) or update an alert. Returns the saved row. */
export async function saveReconAlert(
  id: string | null,
  input: ReconAlertInput
): Promise<ReconAlert> {
  await assertPlatformAdmin();
  const clean = cleanInput(input);
  if (id) return updateAlert(id, clean);
  // Start reading from the newest arrivals run, so a new alert reports what
  // arrives from now on. The mirror being unreachable must not block saving:
  // `now` is the same point in time to within one nightly run.
  const cursor = await latestArrivalRun().catch(() => null);
  return createAlert(clean, cursor ?? new Date().toISOString());
}

export async function setReconAlertEnabled(id: string, enabled: boolean): Promise<ReconAlert> {
  await assertPlatformAdmin();
  const alert = await getMyAlert(id);
  if (!alert) throw new Error("Alert not found.");
  return updateAlert(id, { ...alert, enabled });
}

export async function deleteReconAlert(id: string): Promise<void> {
  await assertPlatformAdmin();
  await deleteAlert(id);
}
