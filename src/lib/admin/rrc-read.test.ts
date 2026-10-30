import { describe, expect, it } from "vitest";
import { prepareRrcSql } from "./rrc-read";

describe("prepareRrcSql", () => {
  it("wraps one statement as a row-capped select", () => {
    const p = prepareRrcSql("select operator_no, count(*) from rrc.well group by 1;");
    expect(p).toEqual({ ok: true, text: "select * from (\nselect operator_no, count(*) from rrc.well group by 1\n) as orion_q limit 2001" });
  });

  it("refuses a second statement, the way a query could end its own transaction", () => {
    for (const sql of ["select 1; commit", "select 1; delete from rrc.well", "commit; delete from rrc.well;"]) {
      expect(prepareRrcSql(sql).ok).toBe(false);
    }
  });

  it("keeps a trailing comment from eating the wrapper", () => {
    const p = prepareRrcSql("select 1 -- why");
    expect(p.ok && p.text.endsWith("\n) as orion_q limit 2001")).toBe(true);
  });

  it("refuses an empty query", () => {
    expect(prepareRrcSql("  ;  ").ok).toBe(false);
  });
});
