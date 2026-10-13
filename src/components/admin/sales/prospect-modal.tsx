"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TaskDescriptionEditor } from "@/components/tasks/task-description-editor";
import { SwipeUpModal } from "@/components/wells/swipe-up-modal";
import { descriptionPreview } from "@/lib/tasks/tasks";
import {
  PROSPECT_COLUMNS,
  type Prospect,
  type ProspectInput,
  type ProspectStage,
} from "@/lib/admin/prospect-types";

/** The task modal's compact value picker, for the stage. */
function StageDropdown({
  value,
  onChange,
}: {
  value: ProspectStage;
  onChange: (value: ProspectStage) => void;
}) {
  const current = PROSPECT_COLUMNS.find((c) => c.stage === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Stage"
            className="flex h-11 w-full items-center justify-between rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        }
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => onChange(v as ProspectStage)}
        >
          {PROSPECT_COLUMNS.map((c) => (
            <DropdownMenuRadioItem key={c.stage} value={c.stage}>
              {c.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MetaInput({
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <Input
        className="h-11"
        type={type}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

interface ProspectModalProps {
  open: boolean;
  /** "add" creates a new prospect; "edit" views/edits an existing one (Save). */
  mode: "add" | "edit";
  onClose: () => void;
  onSubmit: (prospect: ProspectInput) => void;
  /** Existing prospect to seed the form from in "edit" mode. */
  prospect?: Prospect | null;
  /** Default column for a newly added prospect. */
  defaultStage?: ProspectStage;
  /** Delete the prospect being edited; omit to hide. The host owns the confirmation. */
  onDelete?: (prospect: Prospect) => void;
}

/**
 * Create/edit prospect modal, the task modal's shape: company and notes on
 * the left, the contact and pipeline meta stacked on the right. Edits are held
 * locally and only reach the board on Add Prospect / Save.
 */
export function ProspectModal({
  open,
  mode,
  onClose,
  onSubmit,
  prospect,
  defaultStage = "queue",
  onDelete,
}: ProspectModalProps) {
  const [company, setCompany] = useState("");
  const [notes, setNotes] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [county, setCounty] = useState("");
  const [wells, setWells] = useState("");
  const [source, setSource] = useState("");
  const [stage, setStage] = useState<ProspectStage>(defaultStage);
  // Bumped on each open so the (uncontrolled) editor remounts with fresh seed.
  const [editorKey, setEditorKey] = useState(0);

  useEffect(() => {
    if (open) {
      setCompany(prospect?.company ?? "");
      setNotes(prospect?.notes ?? "");
      setContactName(prospect?.contactName ?? "");
      setEmail(prospect?.email ?? "");
      setPhone(prospect?.phone ?? "");
      setCounty(prospect?.county ?? "");
      setWells(prospect?.wells != null ? String(prospect.wells) : "");
      setSource(prospect?.source ?? "");
      setStage(prospect?.stage ?? defaultStage);
      setEditorKey((k) => k + 1);
    }
  }, [open, prospect, defaultStage]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = company.trim();
    if (!trimmed) return;
    const hasNotes = descriptionPreview(notes).length > 0;
    const wellsNum = wells.trim() === "" ? undefined : Number(wells);
    const text = (v: string) => (v.trim() ? v.trim() : undefined);
    onSubmit({
      company: trimmed,
      notes: hasNotes ? notes : undefined,
      contactName: text(contactName),
      email: text(email),
      phone: text(phone),
      county: text(county),
      wells: wellsNum != null && Number.isInteger(wellsNum) && wellsNum >= 0 ? wellsNum : undefined,
      source: text(source),
      stage,
    });
    onClose();
  }

  const isEdit = mode === "edit";
  const canDelete = isEdit && onDelete != null && prospect != null;

  return (
    <SwipeUpModal
      open={open}
      onClose={onClose}
      title={isEdit ? "Prospect" : "Add Prospect"}
      description={
        isEdit
          ? "Make changes, then click Save to apply them."
          : "Fill in the details, then choose where it lands."
      }
      className="max-w-5xl"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-[58vh] min-h-0">
          <div className="flex min-w-0 flex-1 flex-col gap-4 border-r px-5 py-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Company</span>
              <Input
                className="h-11"
                required
                autoFocus
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Operator name"
              />
            </label>

            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <span className="text-sm font-medium">Notes</span>
              <TaskDescriptionEditor
                key={editorKey}
                initialContent={prospect?.notes ?? ""}
                onChange={setNotes}
                placeholder="Calls, who they know, what they run…"
              />
            </div>
          </div>

          <div className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto px-5 py-5">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Stage</span>
              <StageDropdown value={stage} onChange={setStage} />
            </div>
            <MetaInput label="Contact" value={contactName} onChange={setContactName} />
            <MetaInput label="Email" type="email" value={email} onChange={setEmail} />
            <MetaInput label="Phone" type="tel" value={phone} onChange={setPhone} />
            <MetaInput label="County" value={county} onChange={setCounty} />
            <MetaInput
              label="Wells"
              inputMode="numeric"
              value={wells}
              onChange={(v) => setWells(v.replace(/[^0-9]/g, ""))}
            />
            <MetaInput label="Source" value={source} onChange={setSource} placeholder="Referral, RRC list…" />
          </div>
        </div>

        <div
          className={cn(
            "flex items-center gap-2 border-t px-5 py-4",
            canDelete ? "justify-between" : "justify-end"
          )}
        >
          {canDelete && (
            <Button
              type="button"
              variant="destructive"
              size="lg"
              onClick={() => onDelete(prospect)}
            >
              <Trash2Icon className="size-4" />
              Delete
            </Button>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="lg">
              {isEdit ? "Save" : "Add Prospect"}
            </Button>
          </div>
        </div>
      </form>
    </SwipeUpModal>
  );
}
