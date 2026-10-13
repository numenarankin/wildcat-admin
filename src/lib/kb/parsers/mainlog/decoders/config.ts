/**
 * Config members: display, view and program settings. Layouts and sizes are
 * from docs/plans/mainlog-format-companions.md (traced from mainlog.exe);
 * "doc" in comments means that file, section 19 unless noted.
 *
 * Only CONFIRMED content is emitted. Where the doc confirms the exact size but
 * not the fields (`.cfg`, `.clr`, `.lfg`, `.grdx`, `.wfg`, `.dbc`), the size is
 * checked and the member is reported as `{ bytes, fieldsMapped: false }`, so
 * no colour, track or path is passed off as decoded. MainLog itself rejects a
 * wrong size (converter, rebuild or rename), so a wrong size throws here.
 *
 * Pure: no DOM, no fs, no Buffer.
 */

import {
  MainLogFormatError,
  type MainLogContribution,
  type MainLogDecoder,
  type MainLogMember,
} from "../types";
import { asciiz, bytesToText } from "../text";

/** A member whose exact size is confirmed and whose fields are not. */
export interface SizeOnlySettings {
  bytes: number;
  fieldsMapped: false;
}

function settings(member: MainLogMember, data: object): MainLogContribution {
  return { settings: [{ member: member.name, data: data as Record<string, unknown> }] };
}

function expectSize(member: MainLogMember, size: number, what: string): void {
  if (member.bytes.length !== size) {
    throw new MainLogFormatError(
      `${member.name} is ${member.bytes.length} bytes; a MainLog ${what} is exactly ${size}`,
      member.name
    );
  }
}

function sizeOnly(member: MainLogMember, size: number, what: string): MainLogContribution {
  expectSize(member, size, what);
  const data: SizeOnlySettings = { bytes: size, fieldsMapped: false };
  return settings(member, data);
}

// ── .cfg ────────────────────────────────────────────────────────────────────

/** Per-well `.cfg` (and `default.cfg`): 0x42352f `cmp eax,0x1495`. */
export const CFG_WELL_BYTES = 0x1495;

/** Program-level `.cfg` files whose size the doc confirms, by lower-case name. */
const CFG_PROGRAM_BYTES: Record<string, number> = {
  "mldlcfg.cfg": 0x30e, // 0x423097
  "gasmon.cfg": 0x684, // 0x605d4d
};

/** Program-level `.cfg` files the doc names without a confirmed size. */
const CFG_PROGRAM_UNSIZED = new Set(["wits.cfg", "enable.cfg", "lascfg.cfg", "gasedits.cfg"]);

export const cfgDecoder: MainLogDecoder = {
  exts: ["cfg"],
  decode(member) {
    const name = member.name.toLowerCase();
    if (CFG_PROGRAM_UNSIZED.has(name)) {
      throw new MainLogFormatError(`${member.name}: layout not confirmed`, member.name);
    }
    const programSize = CFG_PROGRAM_BYTES[name];
    if (programSize !== undefined) return sizeOnly(member, programSize, name);
    return sizeOnly(member, CFG_WELL_BYTES, "well .cfg");
  },
};

// ── .sch ────────────────────────────────────────────────────────────────────

export const SCH_RECORD_BYTES = 0x142;
export const SCH_RECORDS = 6;
/** Scheme name within a record (0x609272). */
const SCH_NAME_OFFSET = 0xa0;

export interface SchSettings {
  /** Scheme names in file order; record 0 is MainLog's `Mudlog`, record 1 `Custom`. Null when blank. */
  schemes: { index: number; name: string | null }[];
}

export const schDecoder: MainLogDecoder = {
  exts: ["sch"],
  decode(member) {
    expectSize(member, SCH_RECORDS * SCH_RECORD_BYTES, ".sch");
    const schemes: SchSettings["schemes"] = [];
    for (let i = 0; i < SCH_RECORDS; i++) {
      const at = i * SCH_RECORD_BYTES;
      // The name buffer's length is not traced; the record end bounds it, and the
      // first NUL ends it (bytes after it are stale, doc section 0).
      schemes.push({ index: i, name: asciiz(member.bytes, at + SCH_NAME_OFFSET, SCH_RECORD_BYTES - SCH_NAME_OFFSET) });
    }
    const data: SchSettings = { schemes };
    return settings(member, data);
  },
};

// ── size-only binaries ──────────────────────────────────────────────────────

/** Exact sizes confirmed in code; entry layouts are not. */
export const SIZE_ONLY_BYTES = {
  clr: 0x2200, // log colours, 0x497ac8
  lfg: 0x200, // custom shale colours, 0x497de0
  grdx: 0x40c0, // custom tracks, 0x488595
  wfg: 0xe50, // WITS chart config, 0x5ecb99
  dbc: 0x3878, // 0x423938
} as const;

export const sizeOnlyDecoder: MainLogDecoder = {
  exts: Object.keys(SIZE_ONLY_BYTES),
  decode(member) {
    const size = SIZE_ONLY_BYTES[member.ext as keyof typeof SIZE_ONLY_BYTES];
    if (size === undefined) {
      throw new MainLogFormatError(`${member.name}: no confirmed size for .${member.ext}`, member.name);
    }
    return sizeOnly(member, size, `.${member.ext}`);
  },
};

// ── .hor ────────────────────────────────────────────────────────────────────

/** Doc section 12: 0x58b7f9 renames any other size to `.ho_`. */
export const HOR_BYTES = 0x2655a;

export interface HorSettings {
  bytes: number;
  /** The horizontal-section array (memcpy loop 0x58ba50); section fields are not mapped. */
  sections: { offset: number; count: number; recordBytes: number };
  /** The pending copy MainLog migrates into `sections` when a slot is empty. */
  pendingSections: { offset: number; count: number; recordBytes: number };
  fieldsMapped: false;
}

export const horDecoder: MainLogDecoder = {
  exts: ["hor"],
  decode(member) {
    expectSize(member, HOR_BYTES, ".hor");
    const data: HorSettings = {
      bytes: HOR_BYTES,
      sections: { offset: 0x3e2, count: 10, recordBytes: 0x38 },
      pendingSections: { offset: 0x26167, count: 10, recordBytes: 0x38 },
      fieldsMapped: false,
    };
    return settings(member, data);
  },
};

// ── .pek ────────────────────────────────────────────────────────────────────

export interface PekSettings {
  /** The two integers MainLog writes, in file order; their meaning is not confirmed. */
  ints: [number, number];
  text: string;
}

const INT_LINE = /^ (-?\d+) *$/;

/** Written with `" %-5d\n %-5d\n %s\n "` (0x423c79), text mode. */
export const pekDecoder: MainLogDecoder = {
  exts: ["pek"],
  decode(member) {
    const lines = bytesToText(member.bytes).split(/\r?\n/);
    const a = INT_LINE.exec(lines[0] ?? "");
    const b = INT_LINE.exec(lines[1] ?? "");
    const t = lines[2];
    const tail = lines.slice(3).join("\n");
    if (!a || !b || t === undefined || !t.startsWith(" ") || tail.trim() !== "") {
      throw new MainLogFormatError(`${member.name} does not match MainLog's .pek format`, member.name);
    }
    const data: PekSettings = { ints: [Number(a[1]), Number(b[1])], text: t.slice(1) };
    return settings(member, data);
  },
};

// ── .ini ────────────────────────────────────────────────────────────────────

export interface StartupIniSettings {
  lastFile: string;
  Left: number;
  Top: number;
  Width: number;
  Height: number;
  End: number;
}

const INI_KEYS = ["Left", "Top", "Width", "Height", "End"] as const;

/** `startup.ini` (0x426224): `%s\n` last file, then `Left=%d` .. `End=%d`. No other `.ini` is confirmed. */
export const iniDecoder: MainLogDecoder = {
  exts: ["ini"],
  decode(member) {
    if (member.name.toLowerCase() !== "startup.ini") {
      throw new MainLogFormatError(`${member.name}: layout not confirmed`, member.name);
    }
    const lines = bytesToText(member.bytes).split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const bad = () => new MainLogFormatError(`${member.name} does not match MainLog's startup.ini format`, member.name);
    if (lines.length !== 1 + INI_KEYS.length) throw bad();
    const values: Partial<Record<(typeof INI_KEYS)[number], number>> = {};
    INI_KEYS.forEach((key, i) => {
      const m = new RegExp(`^${key}=(-?\\d+)$`).exec(lines[i + 1]);
      if (!m) throw bad();
      values[key] = Number(m[1]);
    });
    const data = { lastFile: lines[0], ...values } as StartupIniSettings;
    return settings(member, data);
  },
};

// ── .ifg ────────────────────────────────────────────────────────────────────

/** Doc: archived beside `.lfg`/`.clr` (0x41a90c); format unknown. Reported, never guessed. */
export const ifgDecoder: MainLogDecoder = {
  exts: ["ifg"],
  decode(member) {
    throw new MainLogFormatError(`${member.name}: layout not confirmed`, member.name);
  },
};

export const CONFIG_DECODERS: MainLogDecoder[] = [
  cfgDecoder,
  schDecoder,
  sizeOnlyDecoder,
  horDecoder,
  pekDecoder,
  iniDecoder,
  ifgDecoder,
];
