import { describe, it, expect } from "vitest";
import {
  addDays,
  advance,
  DEFAULT_SEQUENCE_STEPS,
  fillTemplate,
  isGenericEmail,
  nextOccurrence,
  stepDueOn,
  weekdayOf,
  zonedTimeToUtc,
} from "./types";

/**
 * Hand-computed calendars. 2026-10-06 is a Tuesday, 2026-10-08 a Thursday
 * (today, the day this was written). Central time is UTC-5 in October (CDT)
 * and UTC-6 from 2026-11-01 (CST).
 */

describe("calendar helpers", () => {
  it("knows the weekday", () => {
    expect(weekdayOf("2026-10-06")).toBe(2);
    expect(weekdayOf("2026-10-08")).toBe(4);
    expect(weekdayOf("2026-10-11")).toBe(0);
  });
  it("adds days across a month end", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
  });
});

describe("stepDueOn: email Tuesday, call Thursday, three rounds", () => {
  const steps = DEFAULT_SEQUENCE_STEPS;
  it("enrolled on a Tuesday: the first email is that day", () => {
    expect(stepDueOn("2026-10-06", steps, 0)).toBe("2026-10-06");
    expect(stepDueOn("2026-10-06", steps, 1)).toBe("2026-10-08");
    expect(stepDueOn("2026-10-06", steps, 2)).toBe("2026-10-13");
    expect(stepDueOn("2026-10-06", steps, 5)).toBe("2026-10-22");
  });
  it("enrolled on a Thursday: the first email is next Tuesday", () => {
    expect(stepDueOn("2026-10-08", steps, 0)).toBe("2026-10-13");
    expect(stepDueOn("2026-10-08", steps, 1)).toBe("2026-10-15");
  });
  it("enrolled on a Wednesday", () => {
    expect(stepDueOn("2026-10-07", steps, 0)).toBe("2026-10-13");
  });
  it("has no date past the last step", () => {
    expect(stepDueOn("2026-10-06", steps, 6)).toBeNull();
  });
});

describe("advance", () => {
  it("moves to the next step's date, and to done after the last", () => {
    expect(advance({ enrolledOn: "2026-10-06", stepIndex: 0 }, DEFAULT_SEQUENCE_STEPS)).toEqual({
      stepIndex: 1,
      nextDueOn: "2026-10-08",
      state: "active",
    });
    expect(advance({ enrolledOn: "2026-10-06", stepIndex: 5 }, DEFAULT_SEQUENCE_STEPS)).toEqual({
      stepIndex: 6,
      nextDueOn: null,
      state: "done",
    });
  });
});

describe("zonedTimeToUtc", () => {
  it("resolves Central wall time in CDT and CST", () => {
    expect(zonedTimeToUtc("2026-10-13", "08:00").toISOString()).toBe("2026-10-13T13:00:00.000Z");
    expect(zonedTimeToUtc("2026-11-10", "08:00").toISOString()).toBe("2026-11-10T14:00:00.000Z");
  });
});

describe("nextOccurrence", () => {
  // Thursday 2026-10-08, 10:00 Central = 15:00Z.
  const now = new Date("2026-10-08T15:00:00Z");
  it("a weekday schedule: the coming Tuesday", () => {
    const at = nextOccurrence({ id: "a", name: "Tue 8am", weekday: 2, time: "08:00" }, now);
    expect(at.toISOString()).toBe("2026-10-13T13:00:00.000Z");
  });
  it("today's weekday with the time still ahead: today", () => {
    const at = nextOccurrence({ id: "a", name: "Thu 4pm", weekday: 4, time: "16:00" }, now);
    expect(at.toISOString()).toBe("2026-10-08T21:00:00.000Z");
  });
  it("today's weekday with the time passed: next week", () => {
    const at = nextOccurrence({ id: "a", name: "Thu 8am", weekday: 4, time: "08:00" }, now);
    expect(at.toISOString()).toBe("2026-10-15T13:00:00.000Z");
  });
  it("a daily schedule: tomorrow when today's time has passed", () => {
    const at = nextOccurrence({ id: "a", name: "Daily 8am", weekday: null, time: "08:00" }, now);
    expect(at.toISOString()).toBe("2026-10-09T13:00:00.000Z");
  });
});

describe("isGenericEmail", () => {
  it("tells a mailbox from a person", () => {
    expect(isGenericEmail("info@acmeoil.com")).toBe(true);
    expect(isGenericEmail("Office@acmeoil.com")).toBe(true);
    expect(isGenericEmail("john.doe@acmeoil.com")).toBe(false);
  });
});

describe("fillTemplate", () => {
  it("fills known placeholders and leaves unknown ones", () => {
    expect(fillTemplate("Hi {{first_name}}, {{company}} has {{wells}} wells in {{county}}. {{other}}", {
      first_name: "John",
      company: "Acme Oil",
      wells: "32",
      county: "Midland",
    })).toBe("Hi John, Acme Oil has 32 wells in Midland. {{other}}");
  });
});
