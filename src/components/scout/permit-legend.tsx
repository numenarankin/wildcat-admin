"use client";

/*
 * Key for the Permits mode.
 *
 * Three states, and the order is the life of a permit: filed, granted, drilled.
 * The counts sit beside the swatches because "how many are pending" is the
 * question the colours are there to answer, and a legend that only names the
 * colours makes you count dots to get it.
 */
function Swatch({
  color,
  label,
  count,
}: {
  color: string;
  label: string;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-block size-2.5 rounded-full ring-1 ring-white/70"
        style={{ backgroundColor: color }}
      />
      <span className="text-muted-foreground">{label}</span>
      {count != null && (
        <span className="tabular-nums font-medium">{count.toLocaleString()}</span>
      )}
    </div>
  );
}

export function PermitLegend({
  counts,
}: {
  counts: { total: number; approved: number; drilled: number } | null;
}) {
  return (
    <div className="absolute bottom-8 left-3 z-10 flex flex-col gap-1.5 rounded-lg border bg-background/95 p-2.5 text-xs shadow-lg backdrop-blur">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <Swatch color="#f59e0b" label="Pending" count={counts?.total} />
        <Swatch
          color="#9ca3af"
          label="Approved"
          count={
            counts ? Math.max(0, counts.approved - counts.drilled) : undefined
          }
        />
        <Swatch color="#16a34a" label="Drilled" count={counts?.drilled} />
      </div>
    </div>
  );
}
