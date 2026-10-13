"use client";

import type { Ref } from "react";
import { useDrop } from "react-dnd";
import { cn } from "@/lib/utils";
import {
  ProspectCard,
  PROSPECT_DND_TYPE,
  type ProspectDragItem,
} from "@/components/admin/sales/prospect-card";
import type { Prospect, ProspectColumn as ProspectColumnDef } from "@/lib/admin/prospect-types";

interface ProspectColumnProps {
  column: ProspectColumnDef;
  prospects: Prospect[];
  onDropProspect: (id: string, stage: ProspectColumnDef["stage"]) => void;
  onOpenProspect: (prospect: Prospect) => void;
  /** Delete a prospect from its card; omit to hide the control. */
  onDeleteProspect?: (prospect: Prospect) => void;
}

/** A pipeline column: the task column with prospects for cards. */
export function ProspectColumn({
  column,
  prospects,
  onDropProspect,
  onOpenProspect,
  onDeleteProspect,
}: ProspectColumnProps) {
  const [{ isOver }, dropRef] = useDrop<
    ProspectDragItem,
    unknown,
    { isOver: boolean }
  >(() => ({
    accept: PROSPECT_DND_TYPE,
    drop: (item) => onDropProspect(item.id, column.stage),
    collect: (monitor) => ({ isOver: monitor.isOver() }),
  }), [column.stage, onDropProspect]);

  return (
    <div className="flex min-h-0 min-w-[280px] max-w-[320px] flex-1 flex-col rounded-xl bg-muted/40">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <span className="text-sm font-semibold text-foreground">
          {column.label}
        </span>
        <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
          {prospects.length}
        </span>
      </div>
      <div
        ref={dropRef as unknown as Ref<HTMLDivElement>}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-2 transition-colors",
          isOver && "bg-foreground/5 ring-1 ring-inset ring-foreground/15"
        )}
      >
        {prospects.map((prospect) => (
          <ProspectCard
            key={prospect.id}
            prospect={prospect}
            onOpen={onOpenProspect}
            onDelete={onDeleteProspect}
          />
        ))}
        {prospects.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground/70">
            No prospects
          </p>
        )}
      </div>
    </div>
  );
}
