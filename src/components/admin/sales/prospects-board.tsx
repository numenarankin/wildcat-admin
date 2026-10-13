"use client";

import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { ProspectColumn } from "@/components/admin/sales/prospect-column";
import {
  PROSPECT_COLUMNS,
  type Prospect,
  type ProspectStage,
} from "@/lib/admin/prospect-types";

/**
 * The pipeline: the task board's columns with a stage each. Presentational;
 * the sales workspace owns the rows (the Prospects table shows the same ones)
 * and the writes.
 */
export function ProspectsBoard({
  prospects,
  onDropProspect,
  onOpenProspect,
  onDeleteProspect,
}: {
  prospects: Prospect[];
  onDropProspect: (id: string, stage: ProspectStage) => void;
  onOpenProspect: (prospect: Prospect) => void;
  onDeleteProspect?: (prospect: Prospect) => void;
}) {
  return (
    <DndProvider backend={HTML5Backend}>
      <div className="quiet-scrollbar flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2">
        {PROSPECT_COLUMNS.map((column) => (
          <ProspectColumn
            key={column.stage}
            column={column}
            prospects={prospects.filter((p) => p.stage === column.stage)}
            onDropProspect={onDropProspect}
            onOpenProspect={onOpenProspect}
            onDeleteProspect={onDeleteProspect}
          />
        ))}
      </div>
    </DndProvider>
  );
}
