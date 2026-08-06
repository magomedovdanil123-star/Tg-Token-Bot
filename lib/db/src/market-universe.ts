/**
 * MOEX shares with official listing level 2.
 *
 * Fund/closed-end-fund instruments are intentionally excluded. This universe
 * is used only by the Smart Money scanners and does not widen unrelated
 * market screens.
 */
export const SECOND_TIER_TICKERS = [
  "ABIO",
  "AKRN",
  "APTK",
  "BAZA",
  "BTBR",
  "DATA",
  "DELI",
  "DIAS",
  "ETLN",
  "FESH",
  "GLRX",
  "HNFG",
  "IVAT",
  "KMAZ",
  "MRKC",
  "MRKP",
  "MRKU",
  "MRKV",
  "MRKZ",
  "MSRS",
  "OGKB",
  "PRMD",
  "RASP",
  "SNGS",
  "SNGSP",
  "SOFL",
  "SVAV",
  "TGKN",
  "TRMK",
  "UGLD",
  "VSMO",
  "WUSH",
] as const;

/**
 * User-requested additions outside the official second-tier universe.
 * OZON and OZPH are both listed as level 1 by MOEX.
 */
export const SMART_MONEY_EXTRA_TICKERS = ["OZON", "OZPH"] as const;

export const SMART_MONEY_TICKERS = [
  ...SECOND_TIER_TICKERS,
  ...SMART_MONEY_EXTRA_TICKERS,
] as const;

export type SecondTierTicker = (typeof SECOND_TIER_TICKERS)[number];
export type SmartMoneyTicker = (typeof SMART_MONEY_TICKERS)[number];