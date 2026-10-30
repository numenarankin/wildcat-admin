import { describe, expect, it } from "vitest";
import { bookingDates, candidateSlots, centralInstant, openSlots, roundDrive, type Busy } from "./rules";

// Expected values are worked by hand from docs/plans/demo-booking.md ("Rules").
// 2026-11-02 is a Monday in CST (UTC-6), so 9:00am Central is 15:00Z.
const MON = "2026-11-02";
const at = (hhmm: string, date = MON) => {
  const [h, m] = hhmm.split(":").map(Number);
  return centralInstant(date, h * 60 + m);
};
const iso = (ms: number) => new Date(ms).toISOString();
const busy = (from: string, to: string, toVisitor: number | null, fromVisitor: number | null = toVisitor): Busy => ({
  start: at(from),
  end: at(to),
  toVisitor,
  fromVisitor,
});
const times = (list: string[]) => list.map((t) => at(t));

describe("candidateSlots", () => {
  it("runs Monday, Thursday and Friday 9:00am to 4:00pm, every 30 minutes", () => {
    for (const day of ["2026-11-02", "2026-11-05", "2026-11-06"]) {
      const slots = candidateSlots(day);
      expect(slots).toHaveLength(15);
      expect(iso(slots[0])).toBe(`${day}T15:00:00.000Z`);
      expect(iso(slots[14])).toBe(`${day}T22:00:00.000Z`);
    }
  });

  it("starts Wednesday at 1:30pm", () => {
    const slots = candidateSlots("2026-11-04");
    expect(slots.map(iso)).toEqual([
      "2026-11-04T19:30:00.000Z",
      "2026-11-04T20:00:00.000Z",
      "2026-11-04T20:30:00.000Z",
      "2026-11-04T21:00:00.000Z",
      "2026-11-04T21:30:00.000Z",
      "2026-11-04T22:00:00.000Z",
    ]);
  });

  it("offers nothing on Tuesday, Saturday or Sunday", () => {
    expect(candidateSlots("2026-11-03")).toEqual([]);
    expect(candidateSlots("2026-11-07")).toEqual([]);
    expect(candidateSlots("2026-11-08")).toEqual([]);
  });

  it("keeps 9:00am Central across the DST change (CDT is UTC-5)", () => {
    expect(iso(candidateSlots("2026-10-26")[0])).toBe("2026-10-26T14:00:00.000Z");
  });
});

describe("openSlots", () => {
  it("offers every slot on an empty day", () => {
    expect(openSlots(MON, [])).toHaveLength(15);
  });

  it("waits for the meeting before, the buffer and the drive", () => {
    // 11:00 + 30m + 40m = 12:10, so 12:30 is the first slot.
    expect(openSlots(MON, [busy("9:00", "11:00", 40)])).toEqual(
      times(["12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00"]),
    );
  });

  it("leaves time to reach the meeting after", () => {
    // s + 2h + 30m + 25m <= 3:00pm, so s <= 12:05 and 12:00 is the last slot.
    expect(openSlots(MON, [busy("15:00", "16:00", 25)])).toEqual(
      times(["9:00", "9:30", "10:00", "10:30", "11:00", "11:30", "12:00"]),
    );
  });

  it("checks both sides when a slot sits between two events", () => {
    // After: 10:00 + 30m + 20m = 10:50. Before: 3:00pm - 2h - 30m - 20m = 12:10.
    expect(openSlots(MON, [busy("9:00", "10:00", 20), busy("15:00", "16:00", 20)])).toEqual(times(["11:00", "11:30", "12:00"]));
  });

  it("keeps the 30-minute buffer around an event with no drive", () => {
    // Before: s + 2h + 30m <= 1:00pm. After: s >= 2:00pm + 30m.
    expect(openSlots(MON, [busy("13:00", "14:00", 0)])).toEqual(
      times(["9:00", "9:30", "10:00", "10:30", "14:30", "15:00", "15:30", "16:00"]),
    );
  });

  it("blocks the day for an all-day busy event", () => {
    expect(openSlots(MON, [{ ...busy("0:00", "0:00", 0), end: at("0:00", "2026-11-03"), allDay: true }])).toEqual([]);
  });

  it("blocks slots next to an event with no road route", () => {
    expect(openSlots(MON, [busy("9:00", "10:00", null)])).toEqual([]);
    expect(openSlots(MON, [busy("15:30", "16:00", null)])).toEqual([]);
  });

  it("ignores events on other days", () => {
    expect(openSlots(MON, [busy("9:00", "17:00", 0, 0)].map((b) => ({ ...b, start: b.start - 86_400_000, end: b.end - 86_400_000 })))).toHaveLength(15);
  });
});

describe("roundDrive", () => {
  it("rounds seconds up to the next 5 minutes", () => {
    expect(roundDrive(0)).toBe(0);
    expect(roundDrive(1)).toBe(5);
    expect(roundDrive(300)).toBe(5);
    expect(roundDrive(301)).toBe(10);
    expect(roundDrive(2400)).toBe(40);
  });
});

describe("bookingDates", () => {
  it("runs from tomorrow (Central) for 45 days", () => {
    const dates = bookingDates(Date.parse("2026-10-30T12:00:00Z"));
    expect(dates).toHaveLength(45);
    expect(dates[0]).toBe("2026-10-31");
    expect(dates[44]).toBe("2026-12-14");
  });

  it("uses the Central date late in the evening", () => {
    // 11:30pm CDT on Oct 30 is already Oct 31 in UTC.
    expect(bookingDates(Date.parse("2026-10-31T04:30:00Z"))[0]).toBe("2026-10-31");
  });
});
