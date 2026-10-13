import { toPdqDistrict } from "./rrc-districts";

/**
 * Building the PDQ lease key from the two places Scout has one.
 *
 * A lease is identified by (oil_gas_code, district_no, lease_no) everywhere in
 * PDQ, and every surface that can open a lease holds those three columns in a
 * DIFFERENT shape. Getting either of the two conversions wrong does not fail
 * loudly — it lands on a real lease belonging to someone else.
 *
 * ## 1. District
 *
 * EWA (`rrc.wellbore.district`, what the well modal has) carries the real RRC
 * label: 01-06, 6E, 7B, 7C, 08, 8A, 09, 10. PDQ keys on a sequential internal
 * code where 09 means 7C and 13 means 09. `rrc-districts.ts` has the full story
 * and the worked example of the wrong lease you get by joining them directly.
 *
 * Archon's copy (`well_lease.district_no`, what the operator modal has) is
 * ALREADY the PDQ code — which is why its lease table reads "Dist 13", a
 * district that does not exist in the real world. It needs padding, not
 * translation.
 *
 * ## 2. Lease number width
 *
 * PDQ lease numbers are zero-padded, and the width depends on the commodity:
 *
 *   oil   5 digits   163,527 leases, '00001' .. '71522'
 *   gas   6 digits   222,051 leases, '000002' .. '301774'
 *
 * 73,420 of them begin with a zero. EWA stores the padded string, so the well
 * modal can pass it straight through. Archon stores it as an INTEGER, so those
 * 73,420 arrive stripped and have to be re-padded against the commodity — a
 * bare `String(lease_no)` sends '1234' where the key is '01234' and the lookup
 * 404s, or worse matches a different lease's row.
 *
 * (Widths verified against the mirror, `rrc.lease` grouped by oil_gas_code.)
 */

export interface PdqLeaseKey {
  oil_gas_code: string;
  /** PDQ's internal district code, two digits. */
  district_no: string;
  /** Zero-padded to 5 for oil, 6 for gas. */
  lease_no: string;
}

/** Oil leases are 5 wide, gas 6. Anything else is not a lease key. */
function padLeaseNo(oilGasCode: string, leaseNo: string): string | null {
  const width = oilGasCode === "O" ? 5 : oilGasCode === "G" ? 6 : null;
  if (width === null) return null;
  const digits = leaseNo.trim();
  if (!/^\d+$/.test(digits) || digits.length > width) return null;
  return digits.padStart(width, "0");
}

/**
 * From an EWA wellbore row — the well modal's header.
 *
 * `district` is the real RRC label and is translated. `leaseNumber` is already
 * padded in the source, so padding it again is a no-op that also catches a
 * caller who stripped it somewhere upstream.
 *
 * Null for the 283,167 EWA rows with a blank commodity and an empty lease
 * number: those wellbores are not on a lease and there is nothing to open.
 */
export function leaseKeyFromWellbore(
  oilGasCode: string | null | undefined,
  district: string | null | undefined,
  leaseNumber: string | null | undefined
): PdqLeaseKey | null {
  if (!oilGasCode || !leaseNumber) return null;
  const code = oilGasCode.trim();
  const pdq = toPdqDistrict(district?.trim() ?? null);
  if (!pdq || !/^\d{2}$/.test(pdq)) return null;
  const lease = padLeaseNo(code, leaseNumber);
  if (!lease) return null;
  return { oil_gas_code: code, district_no: pdq, lease_no: lease };
}

/**
 * From Archon's lease row — the operator modal's table.
 *
 * `districtNo` is already PDQ (it is loaded from PDQ), so it is padded and NOT
 * translated. `leaseNo` is an integer and is re-padded to the commodity width.
 */
export function leaseKeyFromArchon(
  oilGasCode: string | null | undefined,
  districtNo: number | null | undefined,
  leaseNo: number | null | undefined
): PdqLeaseKey | null {
  if (!oilGasCode || districtNo == null || leaseNo == null) return null;
  const code = oilGasCode.trim();
  const pdq = String(districtNo).padStart(2, "0");
  if (!/^\d{2}$/.test(pdq)) return null;
  const lease = padLeaseNo(code, String(leaseNo));
  if (!lease) return null;
  return { oil_gas_code: code, district_no: pdq, lease_no: lease };
}
