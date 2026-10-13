import { timed } from "@/lib/perf/timeline";
import "server-only";
import type { Commodity, PricePoint } from "@/lib/pricing/types";
import { DAY_SECONDS, closeAtOrBefore } from "@/lib/pricing/quote-change";
import { PRICE_INTRADAY_DAYS } from "@/lib/sync/contract";

/**
 * Shared commodity price feed (Yahoo Finance chart endpoint). Powers both the
 * topbar ticker / pricing chart API routes and Orion's price tools, so the
 * upstream fetch + in-memory caching live in one place. Yahoo's feed is
 * unofficial + exchange-delayed (~10 min) — fine for a ticker, not for billing.
 */

/** One intraday bar: epoch SECONDS (the chart endpoint's own unit) and a close. */
export interface PriceTick {
  at: number;
  price: number;
}

/** A latest quote for the ticker: price + change over the last 24 hours. */
export interface CommodityQuote {
  /** Short display label, e.g. "WTI". */
  label: string;
  /** Unit suffix, e.g. "/bbl". */
  unit: string;
  /** Latest price in USD. */
  price: number;
  /** Percent change vs this commodity's price 24 hours ago. */
  changePct: number;
}

const UA = "Mozilla/5.0 (compatible; SkyTicker/1.0)";

const SYMBOLS: { symbol: string; label: string; unit: string }[] = [
  { symbol: "CL=F", label: "WTI", unit: "/bbl" },
  { symbol: "NG=F", label: "Nat Gas", unit: "/MCF" },
];

/** App commodity → Yahoo futures symbol. */
const SYMBOL: Record<Commodity, string> = {
  oil: "CL=F", // WTI crude
  gas: "NG=F", // Henry Hub natural gas
};

/** App range token → Yahoo range token. */
const RANGE: Record<string, string> = {
  "1M": "1mo",
  "3M": "3mo",
  "12M": "1y",
  "5Y": "5y",
  // The longest window Yahoo serves at a daily interval; see `fetchMaxSeries`.
  "10Y": "10y",
  // Everything the contract has ever traded, which for CL=F and NG=F starts
  // around 2000. The lease page's RRC history reaches back decades further, and
  // pricing a 1994 barrel at the oldest price in a 5-year window would be a
  // wrong number rather than an old one. Months the series does not reach go
  // unpriced instead. Served by `fetchMaxSeries`, not by one request — see
  // there for why asking Yahoo for `max` at a daily interval does not work.
  MAX: "max",
};

const QUOTE_TTL_MS = 60_000;
/**
 * Stale-while-revalidate. Past its TTL a cached value is still SERVED, with a
 * refresh started behind it, so a page never waits on Yahoo once this process
 * has seen a price. Six calls on a render came to ~150ms wall on a good day
 * and a whole slow morning on a bad one, for numbers that move by the minute.
 * Beyond this age the value is too old to show and the caller waits as before.
 */
const SWR_MAX_AGE_MS = 60 * 60_000;
/** Fresh: serve. Stale: serve and refresh. Too old (or absent): wait. */
function ageState(at: number | undefined, ttl: number): "fresh" | "stale" | "miss" {
  if (at === undefined) return "miss";
  const age = Date.now() - at;
  return age < ttl ? "fresh" : age < SWR_MAX_AGE_MS ? "stale" : "miss";
}
/** Intraday bars move with the quote, so they age with it. */
const INTRADAY_TTL_MS = QUOTE_TTL_MS;
const HISTORY_TTL_MS = 5 * 60_000;

let quoteCache: { at: number; quotes: CommodityQuote[] } | null = null;
const intradayCache = new Map<Commodity, { at: number; bars: PriceTick[] }>();
const historyCache = new Map<string, { at: number; series: PricePoint[] }>();
/** Fetches in progress, keyed like `historyCache`; see `getPriceHistory`. */
const historyInflight = new Map<string, Promise<PricePoint[]>>();
let quotesInflight: Promise<CommodityQuote[]> | null = null;

interface YahooMeta {
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
}

interface YahooChart {
  chart?: {
    result?: {
      meta?: YahooMeta;
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
}

async function fetchYahoo(url: string): Promise<YahooChart | null> {
  // Yahoo rejects requests without a browser-like User-Agent.
  const res = await timedFetchCall(url, {
    headers: { "User-Agent": UA },
    cache: "no-store",
  });
  if (!res.ok) {
    console.error(`yahoo finance ${res.status} for ${url}`);
    return null;
  }
  return (await res.json()) as YahooChart;
}

/**
 * The latest price plus the price of the same contract 24 hours earlier.
 *
 * The comparison used to be Yahoo's `chartPreviousClose`, which is the previous
 * SETTLEMENT, not a day ago: at 2pm it compares against a price ~19 hours old,
 * and first thing Monday against Friday's, so the number moved for reasons that
 * had nothing to do with the last day of trading.
 *
 * So this asks for five days of hourly bars in the same single request the quote
 * already cost, and reads back the last bar at or before (now - 24h) — wall
 * clock now, not the last tick. Futures close for an hour a day and all weekend,
 * so an exact 24h-ago bar often does not exist; taking the last one before the
 * mark gives the most recent price that WAS the price 24 hours ago, which is the
 * honest reading of the question. Once a weekend is more than a day old on both
 * ends of the window, both sides are Friday's close and the chip reads flat,
 * instead of holding Friday's move until Monday.
 *
 * Falls back to the previous close when the series is missing or too short —
 * a slightly-off percentage beats a blank chip.
 */
async function fetchQuote(
  symbol: string
): Promise<{ price: number; prior: number } | null> {
  const data = await fetchYahoo(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=5d&interval=1h`
  );
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return null;
  const price = meta.regularMarketPrice;

  const prevClose =
    typeof meta.chartPreviousClose === "number"
      ? meta.chartPreviousClose
      : typeof meta.previousClose === "number"
        ? meta.previousClose
        : price;

  // Anchored to now, not to the last tick. Anchoring to `regularMarketTime`
  // measured the last 24 hours the market was OPEN, so all weekend the chip
  // held Friday's move; the question is what changed in the last 24 hours,
  // with the last print carried forward through the shutdown.
  const cutoff = Math.floor(Date.now() / 1000) - DAY_SECONDS;

  const prior = closeAtOrBefore(
    result?.timestamp ?? [],
    result?.indicators?.quote?.[0]?.close ?? [],
    cutoff
  );

  return { price, prior: prior ?? prevClose };
}

/** Latest WTI + Henry Hub quotes with 24h change (cached ~1 min). Last good data on a blip. */
export async function getCommodityQuotes(): Promise<CommodityQuote[]> {
  const state = ageState(quoteCache?.at, QUOTE_TTL_MS);
  if (state === "fresh") return quoteCache!.quotes;
  // Same in-flight sharing as `getPriceHistory`: concurrent cold callers used
  // to each fetch both symbols.
  if (!quotesInflight) {
    quotesInflight = loadCommodityQuotes().finally(() => {
      quotesInflight = null;
    });
  }
  if (state === "stale") return quoteCache!.quotes;
  return quotesInflight;
}

async function loadCommodityQuotes(): Promise<CommodityQuote[]> {
  const last = new Map((quoteCache?.quotes ?? []).map((q) => [q.label, q]));
  const quotes: CommodityQuote[] = [];
  let fresh = 0;
  // One symbol at a time. Fired together, the second request of the pair is
  // the one Yahoo rate-limits from a datacenter IP, which is how the ticker
  // came to show oil and never gas on prod.
  for (const s of SYMBOLS) {
    let quote: CommodityQuote | null = null;
    try {
      const q = await fetchQuote(s.symbol);
      if (q) {
        const changePct = q.prior ? ((q.price - q.prior) / q.prior) * 100 : 0;
        quote = { label: s.label, unit: s.unit, price: q.price, changePct };
        fresh++;
      }
    } catch (error) {
      console.error(`price fetch failed for ${s.symbol}`, error);
    }
    // Last good is kept PER SYMBOL: a blip on one must not drop the other.
    const kept = quote ?? last.get(s.label) ?? null;
    if (kept) quotes.push(kept);
  }
  if (fresh > 0) quoteCache = { at: Date.now(), quotes };
  return quotes;
}

/**
 * The last {@link PRICE_INTRADAY_DAYS} of hourly bars, oldest first.
 *
 * The same request `fetchQuote` makes for its own 24-hour comparison, exposed
 * so the sync snapshot can carry it: a handset cannot poll a feed, and a
 * percentage computed here would be frozen at the moment of the sync. Given the
 * bars, the device applies `closeAtOrBefore` against its own clock, which is
 * the webapp's rule run in the webapp's absence.
 */
export async function getIntradayBars(commodity: Commodity): Promise<PriceTick[]> {
  const hit = intradayCache.get(commodity);
  const state = ageState(hit?.at, INTRADAY_TTL_MS);
  if (state === "fresh") return hit!.bars;
  let run = intradayInflight.get(commodity);
  if (!run) {
    run = loadIntradayBars(commodity).finally(() => {
      intradayInflight.delete(commodity);
    });
    intradayInflight.set(commodity, run);
  }
  if (state === "stale") return hit!.bars;
  return run;
}

const intradayInflight = new Map<Commodity, Promise<PriceTick[]>>();

async function loadIntradayBars(commodity: Commodity): Promise<PriceTick[]> {
  const data = await fetchYahoo(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL[commodity])}` +
      `?range=${PRICE_INTRADAY_DAYS}d&interval=1h`
  );
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];

  const bars: PriceTick[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    // A bar with no trades carries a null close; it is a hole in the series,
    // not a price of zero, and `closeAtOrBefore` steps over it either way.
    if (typeof close === "number" && Number.isFinite(close)) {
      bars.push({ at: timestamps[i], price: close });
    }
  }
  // Only cache real data, so a blip serves the last good series (as the quote
  // cache does) rather than an empty one for a minute.
  if (bars.length > 0) intradayCache.set(commodity, { at: Date.now(), bars });
  return bars.length > 0 ? bars : (intradayCache.get(commodity)?.bars ?? []);
}

async function fetchSeries(
  symbol: string,
  yahooRange: string,
  interval = "1d"
): Promise<PricePoint[]> {
  const data = await fetchYahoo(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=${yahooRange}&interval=${interval}`
  );
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];

  const series: PricePoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (typeof close !== "number") continue; // skip gaps/holidays
    series.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      price: close,
    });
  }
  return series;
}

/** The longest window Yahoo actually serves at 1-day granularity. */
const DAILY_MAX_RANGE = "10y";

/**
 * The whole history, at the best granularity Yahoo will actually serve.
 *
 * `range=max` is a trap: whatever interval is asked for, the response comes back
 * as MONTHLY bars (`dataGranularity: "1mo"`) — one point per month, and with
 * whole months simply absent from the series. Every "daily" price for the last
 * quarter century was therefore a single monthly close, and any month Yahoo
 * skipped had no price at all, which is what dashed the revenue on a lease's
 * Feb and Mar 2026 state-reported rows while the months either side were priced.
 *
 * So MAX is two requests: ten years of real daily closes, which is the longest
 * window served at `1d`, plus the monthly series for everything older. A month
 * the daily window covers drops its monthly bar, so a month is either dense or a
 * single bar and never both — a stray bar dated the 1st would otherwise pull
 * that month's average and hand the 1st a price of its own.
 */
async function fetchMaxSeries(symbol: string): Promise<PricePoint[]> {
  const [daily, monthly] = await Promise.all([
    fetchSeries(symbol, DAILY_MAX_RANGE, "1d"),
    fetchSeries(symbol, "max", "1mo"),
  ]);
  if (daily.length === 0) return monthly;
  const dense = new Set(daily.map((p) => p.date.slice(0, 7)));
  const older = monthly.filter((p) => !dense.has(p.date.slice(0, 7)));
  return [...older, ...daily].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
}

const benchmarkCache = new Map<Commodity, { at: number; price: number }>();
const benchmarkInflight = new Map<Commodity, Promise<number | null>>();

/**
 * The commodity's MOST RECENT tick — the benchmark's regular-market price as
 * the feed reports it now. Used to value production on every priced surface
 * (dashboard rows and cards, well and lease tables, the phone's snapshot), so
 * they all read one price at one moment. Cached at the quote's TTL and served
 * stale-while-revalidate like the ticker; returns the last good value on a
 * blip, or null when the feed has nothing.
 *
 * It used to be a 24h average of the hourly bars, cached five minutes, which
 * put a dashboard rendered now a tick off one rendered minutes ago and both a
 * tick off the phone; the operator reads the number against the ticker
 * beside it, and the ticker is the latest print.
 */
export async function getBenchmarkPrice(commodity: Commodity): Promise<number | null> {
  const hit = benchmarkCache.get(commodity);
  const state = ageState(hit?.at, QUOTE_TTL_MS);
  if (state === "fresh") return hit!.price;
  let run = benchmarkInflight.get(commodity);
  if (!run) {
    run = loadBenchmarkPrice(commodity, hit).finally(() => {
      benchmarkInflight.delete(commodity);
    });
    benchmarkInflight.set(commodity, run);
  }
  if (state === "stale") return hit!.price;
  return run;
}

async function loadBenchmarkPrice(
  commodity: Commodity,
  hit: { at: number; price: number } | undefined
): Promise<number | null> {
  const symbol = SYMBOL[commodity] ?? SYMBOL.oil;
  try {
    const quote = await fetchQuote(symbol);
    if (!quote) return hit?.price ?? null;
    benchmarkCache.set(commodity, { at: Date.now(), price: quote.price });
    return quote.price;
  } catch (error) {
    console.error(`benchmark fetch failed for ${symbol}`, error);
    return hit?.price ?? null;
  }
}

/** Daily price history for one commodity over a range (cached ~5 min). */
export async function getPriceHistory(
  commodity: Commodity,
  range: string
): Promise<PricePoint[]> {
  const symbol = SYMBOL[commodity] ?? SYMBOL.oil;
  const yahooRange = RANGE[range] ?? "3mo";
  const key = `${symbol}:${yahooRange}`;

  const hit = historyCache.get(key);
  const state = ageState(hit?.at, HISTORY_TTL_MS);
  if (state === "fresh") return hit!.series;

  /*
   * Share one fetch between concurrent misses. The cache above holds RESOLVED
   * series only, so on a cold process every caller that arrives before the
   * first fetch returns misses too and fetches again: measured as `yahoo
   * finance` 8x on one render for 4 distinct keys. The in-flight promise is the
   * cache entry until the real one exists.
   */
  const pending = historyInflight.get(key);
  if (pending) return state === "stale" ? hit!.series : pending;
  const run = (async () => {
    try {
      const series =
        yahooRange === "max"
          ? await fetchMaxSeries(symbol)
          : await fetchSeries(symbol, yahooRange);
      if (series.length > 0) historyCache.set(key, { at: Date.now(), series });
      return series.length > 0 ? series : (hit?.series ?? []);
    } catch (error) {
      console.error(`price history fetch failed for ${key}`, error);
      return hit?.series ?? [];
    } finally {
      historyInflight.delete(key);
    }
  })();
  historyInflight.set(key, run);
  return state === "stale" ? hit!.series : run;
}

/**
 * `fetch` with the call recorded on the request timeline. Yahoo sits on the
 * render path of every page that shows a price, and it is an external host: a
 * slow morning there looked exactly like a slow database from the outside.
 */
function timedFetchCall(url: string, init?: RequestInit) {
  return timed("http", "yahoo finance", () => fetch(url, init));
}
