/**
 * `.las` members: MainLog's own LAS export, or any LAS packed into the bundle.
 * Read with the existing `parseLas`, data included, and handed on as an eLog.
 * `parseMainLog` cross-checks it against the native curves and fills curves
 * the native log lacks; this decoder only reads.
 */

import { parseLas } from "@/lib/kb/parsers/las";
import { MainLogFormatError, type MainLogDecoder } from "../types";
import { bytesToText } from "../text";

export const lasDecoder: MainLogDecoder = {
  exts: ["las"],
  decode(member) {
    const las = parseLas(bytesToText(member.bytes), true);
    // A depth column alone is not a log.
    if (las.curves.length < 2 || las.rowCount === 0) {
      throw new MainLogFormatError(`${member.name} has no curve data`, member.name);
    }
    return { eLogs: [{ member: member.name, las }] };
  },
};
