/**
 * `.mlx` members: MainLog's "custom track file" (doc: docs/plans/mainlog-format-mlw.md,
 * "`.mlx`"). 222-byte records, no header, one per foot, a float depth at +0.
 *
 * Only CONFIRMED channels are decoded. Pump output (+0xb6) is PARTIAL, the
 * motor revs per gallon (+0x38) only feeds derived values, the mud temperature
 * at +0xc2 is read by one logger only, and TOTRPM / GPM are export derivations;
 * none of those are emitted. Values are the stored floats: the export's integer
 * truncation is formatting, not data.
 *
 * A contribution cannot set the well's depth axis. This decoder returns its own
 * 1-ft depths with its curves, and `parseMainLog` lays them onto the primary
 * log's axis by exact depth.
 */

import {
  MainLogFormatError,
  type MainLogContribution,
  type MainLogCurve,
  type MainLogDecoder,
  type MainLogMember,
} from "../types";
import { MAINLOG_CURVES } from "../curves";

export const MLX_RECORD_BYTES = 222;

interface Channel {
  offset: number;
  mnemonic: string;
  unit: string;
  /** Used when the plain LAS export has no `~Curve` line for this channel. */
  description: string;
  /** The export's accept window; nonzero values outside it are no reading. */
  accept?: (x: number) => boolean;
}

/**
 * Mnemonics: the plain LAS export's where it prints the channel (`curves.ts`),
 * else MainLog's custom LAS (SPP, TORQ, SPM, PVT). Rotary RPM appears only
 * inside the export's TOTRPM sum, so it has no vendor mnemonic of its own.
 */
const CHANNELS: readonly Channel[] = [
  { offset: 0x04, mnemonic: "SPP", unit: "PSI", description: "Standpipe pressure" },
  { offset: 0x18, mnemonic: "TORQ", unit: "FT/LBS", description: "Torque" },
  // The export prints WOB only when 0 < x < 150 (0x57810c).
  { offset: 0x1c, mnemonic: "WOB", unit: "UNITS", description: "WOB klbs", accept: (x) => x > 0 && x < 150 },
  { offset: 0x20, mnemonic: "RPM", unit: "UNITS", description: "Rotary RPM" },
  { offset: 0x34, mnemonic: "BIT", unit: "IN", description: "Bit diameter" },
  { offset: 0x3c, mnemonic: "SPM", unit: "UNITS", description: "Pump strokes per minute" },
  { offset: 0xaa, mnemonic: "CSNGPSI", unit: "PSI", description: "Casing pressure" },
  { offset: 0xae, mnemonic: "FLOW", unit: "%", description: "Flow" },
  { offset: 0xb2, mnemonic: "PVT", unit: "UNITS", description: "PVT" },
  { offset: 0xba, mnemonic: "GAIN", unit: "BBLS", description: "Gain or loss" },
  { offset: 0xbe, mnemonic: "WITS0142", unit: "PSI", description: "WITS code 0142" },
  { offset: 0xc6, mnemonic: "MSE", unit: "UNITS", description: "MSE" },
];

function fail(member: MainLogMember, reason: string): never {
  throw new MainLogFormatError(reason, member.name);
}

export function decodeMlx(member: MainLogMember): MainLogContribution {
  const bytes = member.bytes;
  const size = bytes.byteLength;
  if (size === 0 || size % MLX_RECORD_BYTES !== 0) {
    fail(member, `${size.toLocaleString("en-US")} bytes is not a whole number of ${MLX_RECORD_BYTES}-byte records`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size);
  const n = size / MLX_RECORD_BYTES;

  const depth = new Float64Array(n);
  const first = view.getFloat32(0, true);
  // MainLog creates a zero-filled file when one is missing (0x416f15).
  if (first === 0 && (n === 1 || view.getFloat32(MLX_RECORD_BYTES, true) === 0)) {
    fail(member, "holds no depths (a blank track file)");
  }
  for (let r = 0; r < n; r++) {
    const d = view.getFloat32(r * MLX_RECORD_BYTES, true);
    if (d !== first + r) {
      fail(member, `record ${r} is at ${d} ft; records must be 1 ft apart from ${first} ft`);
    }
    depth[r] = d;
  }

  const curves: MainLogCurve[] = CHANNELS.map((ch) => {
    const spec = MAINLOG_CURVES.find((c) => c.mnemonic === ch.mnemonic && c.unit === ch.unit);
    const values = new Float64Array(n);
    for (let r = 0; r < n; r++) {
      const x = view.getFloat32(r * MLX_RECORD_BYTES + ch.offset, true);
      values[r] = ch.accept && x !== 0 && !ch.accept(x) ? NaN : x;
    }
    return {
      mnemonic: ch.mnemonic,
      unit: ch.unit,
      description: spec?.description ?? ch.description,
      values,
    };
  });

  return { depthUnit: "ft", step: 1, depth, curves };
}

export const mlxDecoder: MainLogDecoder = {
  exts: ["mlx"],
  decode: (member) => decodeMlx(member),
};
