import { FolderIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WellRow } from "@/components/wells/well-row";
import { slugify } from "@/lib/slug";
import type { ProjectFolder } from "@/lib/projects/folders";

interface FolderListProps {
  folders: ProjectFolder[];
  /** Where a row opens: `${basePath}/[slug]`. The admin side lists its own. */
  basePath?: string;
}

/**
 * Drive-style list of project folders, mirroring the Files browser table
 * (`FileBrowser`). Each row opens that project's workspace at
 * `/projects/[slug]` rather than navigating inline, so the tasks / budget /
 * chat workspace stays the click target.
 */
export function FolderList({ folders, basePath = "/projects" }: FolderListProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-10" />
            <TableHead>Name</TableHead>
            <TableHead className="w-24">Type</TableHead>
            <TableHead className="w-24">Items</TableHead>
            <TableHead className="w-32">Modified</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {folders.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={5}
                className="py-10 text-center text-tertiary-text"
              >
                No projects yet.
              </TableCell>
            </TableRow>
          ) : (
            folders.map((folder) => {
              const count = folder.itemCount ?? 0;
              return (
                <WellRow
                  key={folder.id}
                  href={`${basePath}/${slugify(folder.name)}`}
                  // The name, not the icon column, carries the anchor.
                  linkCell={1}
                >
                  <TableCell>
                    <FolderIcon
                      className="size-4 text-data-accent"
                      fill="currentColor"
                    />
                  </TableCell>
                  <TableCell>
                    <span className="font-medium text-primary-text">
                      {folder.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-tertiary-text">Project</TableCell>
                  <TableCell className="text-tertiary-text">
                    {count} {count === 1 ? "item" : "items"}
                  </TableCell>
                  <TableCell className="text-tertiary-text">
                    {folder.modified || "—"}
                  </TableCell>
                </WellRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
