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

export type SecondTierTicker = (typeof SECOND_TIER_TICKERS)[number];