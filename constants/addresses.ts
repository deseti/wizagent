import type { Address } from "viem";

export const USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000" as Address;

export const STABLE_FX_ADAPTER_V2_ADDRESS =
  (process.env.NEXT_PUBLIC_STABLE_FX_ADAPTER_V2_ADDRESS ||
    "0x400d3935B904cbdB6B5eb2Fd50E6843f1b0AD8d6") as Address;
