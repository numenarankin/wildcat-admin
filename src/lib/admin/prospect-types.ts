/**
 * The sales pipeline's vocabulary, shared by the server reads and the client
 * board (no `server-only` here so the components can import the columns).
 */

/** The pipeline columns, in board order. Stored spelling; the labels are the board's. */
export type ProspectStage =
  | "queue"
  | "reached_out"
  | "meeting_booked"
  | "trial"
  | "won"
  | "lost";

export interface ProspectColumn {
  stage: ProspectStage;
  label: string;
}

export const PROSPECT_COLUMNS: ProspectColumn[] = [
  { stage: "queue", label: "Queue" },
  { stage: "reached_out", label: "Reached Out" },
  { stage: "meeting_booked", label: "Meeting Booked" },
  { stage: "trial", label: "Trial" },
  { stage: "won", label: "Won" },
  { stage: "lost", label: "Lost" },
];

export const PROSPECT_STAGES: ProspectStage[] = PROSPECT_COLUMNS.map((c) => c.stage);

export function isProspectStage(v: string): v is ProspectStage {
  return (PROSPECT_STAGES as string[]).includes(v);
}

/** The board's label for a stored stage. */
export function prospectStageLabel(stage: ProspectStage): string {
  return PROSPECT_COLUMNS.find((c) => c.stage === stage)?.label ?? stage;
}

/** An operator Wildcat is selling to: one row, one card. */
export interface Prospect {
  id: string;
  company: string;
  contactName?: string;
  email?: string;
  phone?: string;
  county?: string;
  /** Rough operator size, as we know it. */
  wells?: number;
  /** Where the lead came from (referral, RRC list, inbound, conference...). */
  source?: string;
  stage: ProspectStage;
  /** Rich text (HTML), same editor as a task description. */
  notes?: string;
  /** When the card last changed column. */
  stageChangedAt: string;
  createdAt: string;
}

/** What the modal submits: everything the user types; the stamps are the server's. */
export type ProspectInput = Omit<Prospect, "id" | "stageChangedAt" | "createdAt">;
