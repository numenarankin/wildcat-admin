/**
 * Recon alerts: shared types and the deep-link shapes (client-safe).
 *
 * An alert is one user's area of interest (RRC county codes) and what to watch
 * in it. The dispatcher mails it the `rrc.arrival` rows first seen since its
 * cursor. See docs/plans/recon-alerts.md.
 */

export const ALERT_KINDS = ["pending_permit", "permit", "well"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Section headings in the email and the checkbox labels in the form. */
export const KIND_LABEL: Record<AlertKind, string> = {
  pending_permit: "Permits filed",
  permit: "Permits approved",
  well: "New wells",
};

export const ALERT_FREQUENCIES = ["daily", "weekly"] as const;
export type AlertFrequency = (typeof ALERT_FREQUENCIES)[number];

export interface ReconAlert {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  countyCodes: number[];
  kinds: AlertKind[];
  frequency: AlertFrequency;
  sendHour: number;
  timezone: string;
  enabled: boolean;
  cursorAt: string | null;
  nextDueAt: string | null;
}

export interface ReconAlertInput {
  name: string;
  countyCodes: number[];
  kinds: AlertKind[];
  frequency: AlertFrequency;
  sendHour: number;
  timezone: string;
  enabled: boolean;
}

/** One new thing in the mirror, with what the email shows about it. */
export interface ArrivalItem {
  kind: AlertKind;
  /** universal_doc_no | permit_number | api8 */
  key: string;
  countyCode: number;
  operatorNumber: string | null;
  operatorName: string | null;
  leaseName: string | null;
  wellNumber: string | null;
  /** Filing purpose ("New drill"), permits only. */
  purpose: string | null;
  totalDepth: number | null;
  /** The RRC's own date: submitted, issued, or completion filed. */
  eventDate: string | null;
  /** The pending application behind an approved permit, when we saw it pend. */
  doc: string | null;
  firstSeen: string;
}

/**
 * The Recon path that opens one item.
 *
 * A permit opens by its application (`doc`) whenever there is one, because
 * that is the record that carries a position; an approved permit we never saw
 * pend opens by its number and lands on its county.
 */
export function itemPath(item: ArrivalItem): string {
  switch (item.kind) {
    case "well":
      return `/recon?well=${encodeURIComponent(item.key)}`;
    case "pending_permit":
      return `/recon?permit=${encodeURIComponent(item.key)}`;
    case "permit":
      return item.doc
        ? `/recon?permit=${encodeURIComponent(item.doc)}`
        : `/recon?permitNo=${encodeURIComponent(item.key)}`;
  }
}

/** Opens Recon on an alert's counties. */
export function alertPath(alertId: string): string {
  return `/recon?alert=${encodeURIComponent(alertId)}`;
}

/** Opens the alerts manager. */
export const MANAGE_ALERTS_PATH = "/recon?alerts=1";

/** The deep-link params Recon understands, parsed and validated. */
export interface ReconLink {
  well?: string;
  permit?: string;
  permitNo?: string;
  alert?: string;
  alerts?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read Recon's search params. Anything malformed is dropped, not guessed at:
 * a link that fails validation opens the plain map.
 */
export function parseReconLink(
  params: Record<string, string | string[] | undefined>
): ReconLink {
  const one = (k: string) => {
    const v = params[k];
    return typeof v === "string" ? v.trim() : undefined;
  };
  const out: ReconLink = {};
  const well = one("well");
  if (well && /^\d{8}$/.test(well)) out.well = well;
  const permit = one("permit");
  // The feed's application id; its shape is not documented, so only the
  // characters it could carry into a query are checked.
  if (permit && /^[A-Za-z0-9-]{1,24}$/.test(permit)) out.permit = permit;
  const permitNo = one("permitNo");
  if (permitNo && /^\d{1,7}$/.test(permitNo)) out.permitNo = permitNo.padStart(7, "0");
  const alert = one("alert");
  if (alert && UUID.test(alert)) out.alert = alert;
  if (one("alerts") === "1") out.alerts = true;
  return out;
}
