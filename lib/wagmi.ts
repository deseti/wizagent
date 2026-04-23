import { createConfig, fallback, http } from "wagmi";
import { injected } from "@wagmi/core";
import { defineChain } from "viem";

const DEFAULT_ARC_TESTNET_RPC_URLS = [
  "https://rpc.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network",
];

function parseRpcUrls(
  explicitUrl: string | undefined,
  explicitList: string | undefined,
  defaults: string[]
) {
  const configured = [explicitList, explicitUrl]
    .flatMap((value) =>
      (value ?? "")
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    );

  return Array.from(new Set(configured.length > 0 ? configured : defaults));
}

function createFallbackTransport(urls: string[]) {
  return fallback(
    urls.map((url) =>
      http(url, {
        retryCount: 1,
        timeout: 10_000,
      })
    )
  );
}

export const ARC_TESTNET_RPC_URLS = parseRpcUrls(
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL,
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URLS,
  DEFAULT_ARC_TESTNET_RPC_URLS
);

export const ARC_TESTNET_RPC_URL = ARC_TESTNET_RPC_URLS[0];

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ARC_TESTNET_RPC_URLS,
    },
    public: {
      http: ARC_TESTNET_RPC_URLS,
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

export const config = createConfig({
  chains: [arcTestnet],
  connectors: [
    injected({
      shimDisconnect: true,
    }),
  ],
  ssr: true,
  transports: {
    [arcTestnet.id]: createFallbackTransport(ARC_TESTNET_RPC_URLS),
  },
});
