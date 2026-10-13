// vt-pbf ships no types and has no @types package. Only the geojson-vt entry
// point is used (src/lib/scout/live-tiler.ts), so declare just that.
declare module "vt-pbf" {
  interface GeojsonVtTile {
    features: unknown[];
  }
  const vtpbf: {
    fromGeojsonVt(
      layers: Record<string, GeojsonVtTile>,
      options?: { version?: number; extent?: number }
    ): Uint8Array;
  };
  export default vtpbf;
}
