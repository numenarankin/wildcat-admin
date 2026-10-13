/**
 * MainLog mud logs: public API. See docs/plans/mlw-mud-logs.md.
 *
 *   readMainLog(name, bytes) -> MainLogWell -> parseMainLog(well) -> ParsedMainLog
 */

export * from "./types";
export { isMainLog, readMainLog, type ReadMainLogOptions } from "./read";
export { parseMainLog } from "./parse";
export { DECODERS, KNOWN_EXTS, CORE_EXTS } from "./registry";

export {
  formatLasNumber,
  mainLogOtherLines,
  mainLogToLasText,
  mainLogToParsedLas,
} from "./renditions";
