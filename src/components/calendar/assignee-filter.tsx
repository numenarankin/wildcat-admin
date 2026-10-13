"use client";

import { ChevronDownIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The bucket a task with no assignee falls into.
 *
 * Underscored so it cannot collide with a real value: `tasks.assignee` is free
 * text, and a plain "Unassigned" would make anyone actually recorded that way
 * disappear along with the unowned pile.
 */
export const UNASSIGNED = "__unassigned__";

/**
 * Whose tasks to show, as a set of HIDDEN people (see {@link personKey}).
 *
 * Hidden rather than selected, so "no filter" is the empty set and everyone is
 * visible by default — including an org member added after the page loaded, who
 * a selected-set would silently leave out of their own agenda.
 */
export type HiddenAssignees = ReadonlySet<string>;

/**
 * Fold a name down to the person behind it.
 *
 * `tasks.assignee` is free text and the member roster is typed by hand, so one
 * person reaches this list spelled several ways — "Rankin Poage" off a profile,
 * "rankin poage" typed onto a task. Keyed on the raw string they are two
 * options with one name between them, and ticking either leaves half their work
 * on screen. Case and runs of whitespace are the differences that carry no
 * meaning; everything else does, so `Jim` and `Jimmy` stay two people.
 */
export function personKey(assignee: string | null | undefined): string {
  return assignee?.trim().replace(/\s+/g, " ").toLowerCase() || UNASSIGNED;
}

/**
 * Assignees that mean "whoever is looking at this".
 *
 * The projects board used to offer a literal "Me" as an assignee, so tasks
 * exist with that written into `tasks.assignee`. To the viewer it is their own
 * name a second time — one box holding some of their tasks and another box
 * holding the rest. Those rows are folded onto the viewer here rather than
 * migrated, because the stored word records no one: nothing on the row says
 * whose "me" it was.
 */
const SELF_REFERENCES = new Set(["me", "myself"]);

/** Resolve a self-referential assignee to the viewer's own name. */
function resolveSelf(name: string, viewer: string | undefined): string {
  if (!viewer) return name;
  return SELF_REFERENCES.has(name.trim().toLowerCase()) ? viewer : name;
}

export function isVisible(
  hidden: HiddenAssignees,
  assignee: string | undefined,
  viewer?: string
): boolean {
  // Folded the same way the options are, or unticking your own box would leave
  // the tasks stored against "Me" on screen with nothing left to hide them by.
  return !hidden.has(personKey(resolveSelf(assignee ?? "", viewer)));
}

/**
 * The names to offer, one entry per person.
 *
 * Members first, then every assignee actually written on a task, then
 * Unassigned when some task has none. `tasks.assignee` is free text, so a task
 * can name someone who is not (or is no longer) an org member; offering only
 * members would leave those tasks permanently filtered out with no box to tick
 * to bring them back.
 *
 * Members are added first so that when a person is spelled two ways, the roster
 * spelling is the one shown.
 */
export function assigneeOptions(
  members: readonly string[],
  taskAssignees: readonly (string | null | undefined)[],
  viewer?: string
): string[] {
  const byPerson = new Map<string, string>();
  function add(raw: string | null | undefined): boolean {
    const trimmed = raw?.trim();
    if (!trimmed) return false;
    const name = resolveSelf(trimmed, viewer);
    const key = personKey(name);
    if (!byPerson.has(key)) byPerson.set(key, name);
    return true;
  }

  for (const member of members) add(member);
  let anyUnassigned = false;
  for (const assignee of taskAssignees) {
    if (!add(assignee)) anyUnassigned = true;
  }

  const sorted = [...byPerson.values()].sort((a, b) => a.localeCompare(b));
  // The viewer leads. Their entry reads "Me" (see `optionLabel`), and a "Me"
  // filed under R because the name behind it is Rankin looks like a mistake.
  const mine = viewer ? sorted.findIndex((n) => personKey(n) === personKey(viewer)) : -1;
  if (mine > 0) sorted.unshift(...sorted.splice(mine, 1));
  return anyUnassigned ? [...sorted, UNASSIGNED] : sorted;
}

/**
 * Filter the agenda down to particular people's tasks.
 *
 * Everyone is shown by default: the agenda is org-wide (the RLS policies scope
 * `tasks` by capability, not by user), so the honest starting point is the whole
 * board, and this narrows it.
 *
 * Options come from the org members UNION the assignee values actually on
 * tasks. `tasks.assignee` is free text, so a task can name someone who is not a
 * member; listing only members would leave those tasks with no way to be
 * filtered back in.
 */
export function AssigneeFilter({
  options,
  hidden,
  viewer,
  onChange,
}: {
  /** Names to offer, already sorted. Include {@link UNASSIGNED} if relevant. */
  options: string[];
  hidden: HiddenAssignees;
  /** The signed-in person's name; their entry reads "Me". */
  viewer?: string;
  onChange: (hidden: ReadonlySet<string>) => void;
}) {
  const shown = options.filter((o) => !hidden.has(personKey(o)));
  const allShown = shown.length === options.length;

  function toggle(name: string, checked: boolean) {
    const next = new Set(hidden);
    if (checked) next.delete(personKey(name));
    else next.add(personKey(name));
    onChange(next);
  }

  const label = allShown
    ? "All people"
    : shown.length === 0
      ? "No one"
      : shown.length === 1
        ? optionLabel(shown[0], viewer)
        : `${shown.length} people`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-2 font-normal"
            aria-label="Filter tasks by assignee"
          />
        }
      >
        <UsersIcon className="size-4 text-muted-foreground" />
        {label}
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56">
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            No one to filter by
          </div>
        ) : (
          <>
            {/*
              A way back to everyone. Unchecking several boxes is quick;
              re-checking them one at a time to undo it is not.
            */}
            <DropdownMenuItem
              className="cursor-pointer"
              disabled={allShown}
              onClick={() => onChange(new Set())}
            >
              Show everyone
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {options.map((name) => (
              <DropdownMenuCheckboxItem
                key={personKey(name)}
                checked={!hidden.has(personKey(name))}
                onCheckedChange={(checked) => toggle(name, checked)}
              >
                {optionLabel(name, viewer)}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * How an option reads in the menu.
 *
 * The viewer is "Me". Their own name is the one entry in this list they never
 * need spelled out — they know who they are, and "Me" is what every other
 * calendar calls them.
 */
export function optionLabel(value: string, viewer?: string): string {
  if (value === UNASSIGNED) return "Unassigned";
  if (viewer && personKey(value) === personKey(viewer)) return "Me";
  return value;
}
