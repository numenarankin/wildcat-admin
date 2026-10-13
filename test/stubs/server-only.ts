// No-op stand-in for the `server-only` package under Vitest. The real package
// throws if imported into a client bundle; in Node unit tests there is no such
// boundary, so importing it must be harmless.
export {};
