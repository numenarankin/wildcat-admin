"use client";

import { CheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UIMessage } from "ai";
import {
  describeApproval,
  humanizeKey,
} from "@/lib/ai/approval-view";

export interface PendingApproval {
  id: string;
  name: string;
  input: unknown;
}

/** Write-tool calls in a message awaiting the user's approve/deny. */
export function pendingApprovals(message: UIMessage): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const part of message.parts) {
    const p = part as {
      type: string;
      state?: string;
      input?: unknown;
      approval?: { id: string };
    };
    if (
      p.type.startsWith("tool-") &&
      p.state === "approval-requested" &&
      p.approval
    ) {
      out.push({
        id: p.approval.id,
        name: p.type.slice("tool-".length),
        input: p.input,
      });
    }
  }
  return out;
}

/** Approve / deny card for a single pending write-tool call. */
export function ApprovalCard({
  request,
  onApprove,
  onDeny,
}: {
  request: PendingApproval;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const view = describeApproval(request.name, request.input);

  return (
    <div className="rounded-[0.15rem] border border-border bg-background p-3">
      <p className="ty-body-2 font-medium text-primary-text">{view.title}</p>
      <p className="mt-0.5 text-xs text-tertiary-text">
        Orion needs your OK before this is saved.
      </p>

      {view.fields.length > 0 && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          {view.fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className="contents">
              <dt className="text-tertiary-text">{f.label}</dt>
              <dd className="text-primary-text break-words">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {view.table && view.table.columns.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-[0.15rem] border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-background-subtle text-left text-tertiary-text">
                {view.table.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2 py-1 font-medium">
                    {humanizeKey(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.table.rows.map((row, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="whitespace-nowrap px-2 py-1 text-primary-text"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {view.table.total > view.table.rows.length && (
            <p className="px-2 py-1 text-xs text-tertiary-text">
              + {view.table.total - view.table.rows.length} more
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" onClick={onApprove}>
          <CheckIcon />
          Approve
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDeny}>
          <XIcon />
          Deny
        </Button>
      </div>
    </div>
  );
}
