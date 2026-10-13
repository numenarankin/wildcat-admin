/**
 * The decoder table. One module per extension under `decoders/`; add it here
 * and `parseMainLog` picks it up. A member whose extension has no decoder is
 * listed in `unknown`, never dropped.
 */

import type { MainLogDecoder } from "./types";
import { bitDecoder } from "./decoders/bit";
import { chtDecoder } from "./decoders/cht";
import { CONFIG_DECODERS } from "./decoders/config";
import { dstDecoder } from "./decoders/dst";
import { fitDecoder } from "./decoders/fit";
import { gasDecoder } from "./decoders/gas";
import { hdrDecoder } from "./decoders/hdr";
import { hxtDecoder } from "./decoders/hxt";
import { lagDecoder } from "./decoders/lag";
import { lasDecoder } from "./decoders/las";
import { MEDIA_DECODERS } from "./decoders/media";
import { memDecoder } from "./decoders/mem";
import { mlcDecoder } from "./decoders/mlc";
import { mlwDecoder } from "./decoders/mlw";
import { mlxDecoder } from "./decoders/mlx";
import { qptDecoder } from "./decoders/qpt";
import { rptDecoder } from "./decoders/rpt";
import { shoDecoder } from "./decoders/sho";
import { topxDecoder } from "./decoders/topx";
import { trgDecoder } from "./decoders/trg";
import { witDecoder } from "./decoders/wit";
import { xrfDecoder } from "./decoders/xrf";

export const DECODERS: MainLogDecoder[] = [
  mlwDecoder, mlxDecoder, lasDecoder,
  hdrDecoder, topxDecoder, memDecoder, hxtDecoder,
  shoDecoder, rptDecoder, qptDecoder, dstDecoder, bitDecoder,
  chtDecoder, witDecoder, gasDecoder, fitDecoder, trgDecoder, lagDecoder, xrfDecoder, mlcDecoder,
  ...CONFIG_DECODERS,
  ...MEDIA_DECODERS,
];

/** Every member kind the manual's file list names (docs/plans/mlw-mud-logs.md, file table). */
export const KNOWN_EXTS: readonly string[] = [
  "mlw", "mlx", "hdr", "top", "topx", "mem", "sho", "rpt", "qpt", "dst", "gas",
  "cht", "wit", "xrf", "mlc", "fit", "las", "hor", "trg", "lag", "cfg", "sch",
  "lfg", "clr", "grdx", "wfg", "hxt", "ini", "jpg", "jpeg", "bmp", "png", "pdf", "pek",
  "dbc", "wav", "bit", "ifg",
];

/** Kinds worth naming when a well arrives without them (`ParsedMainLog.absent`). */
export const CORE_EXTS: readonly string[] = [
  "mlw", "mlx", "hdr", "topx", "mem", "sho", "rpt", "qpt", "las",
];
