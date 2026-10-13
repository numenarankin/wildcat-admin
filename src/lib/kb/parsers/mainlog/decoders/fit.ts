/**
 * `.fit` members: MainLog's FIT chromatograph (doc:
 * docs/plans/mainlog-format-companions.md, section 11). Only the plug-back
 * resize code touches it; record size and fields are UNCONFIRMED (open item
 * 3), so every member is reported in `undecoded`.
 */

import { MainLogFormatError, type MainLogDecoder } from "../types";

export const fitDecoder: MainLogDecoder = {
  exts: ["fit"],
  decode(member) {
    throw new MainLogFormatError(
      "the .fit record size and fields are not yet mapped; nothing in it is confirmed",
      member.name
    );
  },
};
