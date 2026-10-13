import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { countyAt, type CountyFeature } from "./county-at";

const features = (
  JSON.parse(readFileSync(path.join(process.cwd(), "public", "tx-counties.json"), "utf8")) as { features: CountyFeature[] }
).features;

/** City-hall coordinates, and the county each city is in. */
describe("countyAt", () => {
  it("places Texas cities in their county", () => {
    expect(countyAt(-97.3308, 32.7555, features)).toBe(439); // Fort Worth, Tarrant
    expect(countyAt(-102.0779, 31.9973, features)).toBe(329); // Midland, Midland
    expect(countyAt(-95.3698, 29.7604, features)).toBe(201); // Houston, Harris
    expect(countyAt(-96.797, 32.7767, features)).toBe(113); // Dallas, Dallas
  });
  it("is null outside Texas", () => {
    expect(countyAt(-97.5164, 35.4676, features)).toBeNull(); // Oklahoma City
    expect(countyAt(-104.9903, 39.7392, features)).toBeNull(); // Denver
  });
});
