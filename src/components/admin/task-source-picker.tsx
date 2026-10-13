"use client";

import { useRouter } from "next/navigation";
import { ChevronDownIcon, ListTodoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface TaskSourceOption {
  /** "wildcat", or "google:<listId>". */
  value: string;
  label: string;
}

/**
 * Which tasks /admin/tasks is showing: the team's own board, or one of the
 * admin's Google Tasks lists. The Agenda assignee filter's trigger, sized to
 * the Task button beside it. The choice lives in `?source=`.
 */
export function TaskSourcePicker({
  value,
  wildcat,
  google,
}: {
  value: string;
  wildcat: TaskSourceOption;
  google: TaskSourceOption[];
}) {
  const router = useRouter();
  const current = [wildcat, ...google].find((o) => o.value === value) ?? wildcat;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="lg" variant="outline" className="gap-2 font-normal" aria-label="Task list" />
        }
      >
        <ListTodoIcon className="size-4 text-muted-foreground" />
        {current.label}
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56">
        <DropdownMenuRadioGroup
          value={current.value}
          onValueChange={(next) =>
            router.push(next === wildcat.value ? "/tasks" : `/tasks?source=${encodeURIComponent(next)}`)
          }
        >
          <DropdownMenuRadioItem value={wildcat.value}>{wildcat.label}</DropdownMenuRadioItem>
          {google.length > 0 && <DropdownMenuSeparator />}
          {google.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
