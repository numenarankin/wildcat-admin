/**
 * MainLog's own LAS 2.0 export vocabulary, copied from the strings in
 * `mainlog.exe` (MainLog Office 22.5.3). See docs/plans/mainlog-format-mlw.md.
 *
 * Source: the "Create LOG ASCII STANDARD file" routine (VA 0x57642c). Its
 * `~Curve` block (VA 0x57728d to 0x577d40) writes these lines in this order,
 * one data column each, and the `~A` rows (VA 0x579055) print the values in the
 * same order. This is the English template with the plain (non-"ML_")
 * mnemonics. Text is verbatim except runs of spaces are collapsed, so the
 * vendor's spellings ("azimth", "Fluoresence") are kept.
 *
 * Where the exporter picks between two strings, the branch taken with the flag
 * clear is listed:
 * - `MWD-GR` becomes `Gamma` when ctx+0x76c5a is set.
 * - C1..NC5 are `.UNITS`; they become `.PPM` in PPM mode or `.perc` (NC5 `.%`)
 *   in percent mode.
 * - `TOT` becomes `TOTALGAS` for logger id 0x44.
 * - `CACO3 (PERC, "Calcimeter HD")` becomes `HARD (PERC, "Hardness HD")` when
 *   ctx+0x77fc6 is set. Both print record word 0x164.
 * - `CUST1`..`CUST6` become the user's custom lithology names when set.
 *
 * Each `~A` row also ends with 5 unnamed float columns that have no `~Curve`
 * line, so a strict LAS reader sees 81 values against 76 curves.
 *
 * Which of these the `.mlw` decoder emits: `MLW_DECODED_MNEMONICS` below.
 */

export interface MainLogCurve {
  mnemonic: string;
  unit: string;
  description: string;
}

export const MAINLOG_CURVES: readonly MainLogCurve[] = [
  { mnemonic: "DEPTH", unit: "FT", description: "Depth" },
  { mnemonic: "TVD", unit: "FT", description: "True vertical depth" },
  { mnemonic: "INCL", unit: "DEG", description: "Directional survey" },
  { mnemonic: "AZM", unit: "DEG", description: "Directional azimth" },
  { mnemonic: "VS", unit: "FT", description: "Directional Vertical Section" },
  { mnemonic: "ROP", unit: "min/ft", description: "One foot rate min/ft" },
  { mnemonic: "ROP", unit: "ft/hr", description: "One foot rate ft/hr" },
  { mnemonic: "10FTROP", unit: "min/ft", description: "Ten foot rate min/ft" },
  { mnemonic: "5FTROP", unit: "min/ft", description: "Five foot rate min/ft" },
  { mnemonic: "MWD-GR", unit: "GAPI", description: "Gamma Ray" },
  { mnemonic: "ANHY", unit: "perc", description: "Lithology Anhydrite ANH" },
  { mnemonic: "CHERT", unit: "perc", description: "Lithology Chert CHT" },
  { mnemonic: "LIME", unit: "perc", description: "Lithology Limestone LS" },
  { mnemonic: "DOLO", unit: "perc", description: "Lithology Dolomite DOL" },
  { mnemonic: "SS", unit: "perc", description: "Lithology Sandstone SS" },
  { mnemonic: "SILT", unit: "perc", description: "Lithology Siltstone SLT" },
  { mnemonic: "CONG", unit: "perc", description: "Lithology Conglomerate CG" },
  { mnemonic: "SHALE", unit: "perc", description: "Lithology Gray Shale SH" },
  { mnemonic: "COAL", unit: "perc", description: "Lithology Coal CO" },
  { mnemonic: "SALT", unit: "perc", description: "Lithology Salt SALT" },
  { mnemonic: "GRAN", unit: "perc", description: "Lithology Granite GR" },
  { mnemonic: "GRANWSH", unit: "perc", description: "Lithology Granite Wash GW" },
  { mnemonic: "QTZWSH", unit: "perc", description: "Lithology Quartz Wash QW" },
  { mnemonic: "CARBWSH", unit: "perc", description: "Lithology Carbonate Wash CW" },
  { mnemonic: "BEN", unit: "perc", description: "Lithology Bentonite BEN" },
  { mnemonic: "REDSH", unit: "perc", description: "Lithology Red Shales RSH" },
  { mnemonic: "ORGSH", unit: "perc", description: "Lithology Organge Shales OSH" },
  { mnemonic: "GNSH", unit: "perc", description: "Lithology Green Shales GSH" },
  { mnemonic: "CARBSH", unit: "perc", description: "Lithology Carb Shales CS" },
  { mnemonic: "CHK", unit: "perc", description: "Lithology Chalk" },
  { mnemonic: "VOL", unit: "perc", description: "Lithology Volcanics" },
  { mnemonic: "CUST1", unit: "perc", description: "Lithology Cust CL1" },
  { mnemonic: "CUST2", unit: "perc", description: "Lithology Cust CL2" },
  { mnemonic: "CUST3", unit: "perc", description: "Lithology Cust CL3" },
  { mnemonic: "CUST4", unit: "perc", description: "Lithology Cust CL4" },
  { mnemonic: "CUST5", unit: "perc", description: "Lithology Cust CL5" },
  { mnemonic: "CUST6", unit: "perc", description: "Lithology Cust CL6" },
  { mnemonic: "CMT", unit: "perc", description: "Lithology Cement CMT" },
  { mnemonic: "CON", unit: "unit", description: "CONNECTION 1=conn 3= csng pt 4=trip" },
  { mnemonic: "C1", unit: "UNITS", description: "C1" },
  { mnemonic: "C2", unit: "UNITS", description: "C2" },
  { mnemonic: "C3", unit: "UNITS", description: "C3" },
  { mnemonic: "IC4", unit: "UNITS", description: "IC4" },
  { mnemonic: "NC4", unit: "UNITS", description: "NC4" },
  { mnemonic: "IC5", unit: "UNITS", description: "IC5" },
  { mnemonic: "NC5", unit: "UNITS", description: "NC5" },
  { mnemonic: "TOT", unit: "UNITS", description: "Total Gas or H.W." },
  { mnemonic: "CO2", unit: "PERC", description: "Perc CO2 CO2" },
  { mnemonic: "POR", unit: "UNITS", description: "Porosity POR TPFG 1-4" },
  { mnemonic: "FLU", unit: "PERC", description: "Fluoresence FLU" },
  { mnemonic: "FLUQUAL", unit: "UNITS", description: "Fluoresence Quality FQ TPFG 1-4" },
  { mnemonic: "CUT", unit: "UNITS", description: "Cut CUT TPFG 1-4" },
  { mnemonic: "FLARE", unit: "FT", description: "Flare Length FLARE" },
  { mnemonic: "MUDWTOUT", unit: "LB/G", description: "Mud Wt Out WTOUT" },
  { mnemonic: "MUDWTIN", unit: "LB/G", description: "Mud Wt In WTIN" },
  { mnemonic: "GAIN", unit: "BBLS", description: "Gain or Loss GAIN" },
  { mnemonic: "FLOW", unit: "%", description: "Flow FLOW" },
  { mnemonic: "WITS0142", unit: "PSI", description: "WITS CODE 0142" },
  { mnemonic: "DXC", unit: "UNITS", description: "D Exponent Corrected DXC" },
  { mnemonic: "CACO3", unit: "PERC", description: "Calcimeter HD" },
  { mnemonic: "TEMP", unit: "DEG", description: "MUD Temp out TEMP" },
  { mnemonic: "LAGTIME", unit: "MIN", description: "Lagtime LAG" },
  { mnemonic: "SG", unit: "UNITS", description: "SPECIFIC GRAVITY SG" },
  { mnemonic: "WRAT", unit: "UNITS", description: "WETNESS RATIO WR" },
  { mnemonic: "BRAT", unit: "UNITS", description: "BALANCE RATIO BR" },
  { mnemonic: "CRAT", unit: "UNITS", description: "CHARACTER RATIO CR" },
  { mnemonic: "COIN", unit: "UNITS", description: "COMMON OIL INDICATOR" },
  { mnemonic: "TOTRPM", unit: "UNITS", description: "TOTAL RPM" },
  { mnemonic: "WOB", unit: "UNITS", description: "WOB klbs WOB" },
  { mnemonic: "BIT", unit: "IN", description: "HOLE DIAMETER inches DIA" },
  { mnemonic: "SLIDE", unit: "UNITS", description: "1=Slide 0=Rotate SL" },
  { mnemonic: "CUTTINGS", unit: "CM", description: "Size Of Cuttings in CM CTSZ" },
  { mnemonic: "CSNGPSI", unit: "PSI", description: "Casing Pressure in PSI CPSI" },
  { mnemonic: "MSE", unit: "UNITS", description: "MSE" },
  { mnemonic: "QC", unit: "UNITS", description: "QC Value" },
  { mnemonic: "ECD", unit: "LB/G", description: "ECD Value" },
];

/**
 * The mnemonics of `MAINLOG_CURVES` the `.mlw` decoder emits, one curve each,
 * in the template's units. The rest of the template is documentation: it is
 * derived at export (ROP ft/hr, the ratios, 10FTROP, 5FTROP, DXC), comes from
 * another member (`.mlx`, `.mlc`), or is not a confirmed stored field.
 */
export const MLW_DECODED_MNEMONICS: readonly string[] = [
  "TVD", "INCL", "AZM", "VS", "ROP", "CON", "C1", "C2", "C3", "IC4", "NC4", "IC5",
  "NC5", "TOT", "CO2", "POR", "FLU", "FLUQUAL", "CUT", "FLARE", "MUDWTOUT",
  "MUDWTIN", "CACO3", "TEMP", "LAGTIME", "SLIDE", "QC",
];

export interface MainLogLithology {
  /** Column code in MainLog's `~A` header line (VA 0x715c2d). */
  code: string;
  /** Rock name from the `~Curve` description. */
  name: string;
  /** LAS mnemonic from the `~Curve` line (English, non-"ML_" template). */
  mnemonic: string;
}

/**
 * The lithology columns of MainLog's LAS export, in export order. Each value
 * is a whole percent. `name` is the rock name from the `~Curve` description;
 * OSH uses the "ML_" template's "Orange Shales" (VA 0x714621) because the plain
 * template misspells it "Organge". CL1..CL6 are user-defined rocks: the
 * exporter prints the user's name when one is set and "Cust" otherwise.
 *
 * These are export columns, not the codes stored in a record's lithology
 * string. The record codes (for example "L" for limestone, "SD" for sandstone)
 * and how several of them fold into one column are documented in
 * docs/plans/mainlog-format-mlw.md.
 */
export const MAINLOG_LITHOLOGY: readonly MainLogLithology[] = [
  { code: "ANH", name: "Anhydrite", mnemonic: "ANHY" },
  { code: "CHT", name: "Chert", mnemonic: "CHERT" },
  { code: "LS", name: "Limestone", mnemonic: "LIME" },
  { code: "DOL", name: "Dolomite", mnemonic: "DOLO" },
  { code: "SS", name: "Sandstone", mnemonic: "SS" },
  { code: "SLT", name: "Siltstone", mnemonic: "SILT" },
  { code: "CG", name: "Conglomerate", mnemonic: "CONG" },
  { code: "SH", name: "Gray Shale", mnemonic: "SHALE" },
  { code: "CO", name: "Coal", mnemonic: "COAL" },
  { code: "SALT", name: "Salt", mnemonic: "SALT" },
  { code: "GR", name: "Granite", mnemonic: "GRAN" },
  { code: "GW", name: "Granite Wash", mnemonic: "GRANWSH" },
  { code: "QW", name: "Quartz Wash", mnemonic: "QTZWSH" },
  { code: "CW", name: "Carbonate Wash", mnemonic: "CARBWSH" },
  { code: "BEN", name: "Bentonite", mnemonic: "BEN" },
  { code: "RSH", name: "Red Shales", mnemonic: "REDSH" },
  { code: "OSH", name: "Orange Shales", mnemonic: "ORGSH" },
  { code: "GSH", name: "Green Shales", mnemonic: "GNSH" },
  { code: "CS", name: "Carb Shales", mnemonic: "CARBSH" },
  { code: "CHK", name: "Chalk", mnemonic: "CHK" },
  { code: "VOL", name: "Volcanics", mnemonic: "VOL" },
  { code: "CL1", name: "Cust", mnemonic: "CUST1" },
  { code: "CL2", name: "Cust", mnemonic: "CUST2" },
  { code: "CL3", name: "Cust", mnemonic: "CUST3" },
  { code: "CL4", name: "Cust", mnemonic: "CUST4" },
  { code: "CL5", name: "Cust", mnemonic: "CUST5" },
  { code: "CL6", name: "Cust", mnemonic: "CUST6" },
  { code: "CMT", name: "Cement", mnemonic: "CMT" },
];
