import fs from "node:fs";
import path from "node:path";

import { defineConfig } from "hardhat/config";
import hardhatVerify from "@nomicfoundation/hardhat-verify";

const ROOT_DIR = process.cwd();
const DEFAULT_ARC_RPC_URL = "https://rpc.testnet.arc.network";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.resolve(ROOT_DIR, ".env.local"));
loadEnvFile(path.resolve(ROOT_DIR, ".env"));

const rpcUrl =
  process.env.ARC_TESTNET_RPC_URL ??
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ??
  DEFAULT_ARC_RPC_URL;

const privateKey = process.env.ARC_DEPLOYER_PRIVATE_KEY;
const normalizedPrivateKey =
  privateKey && privateKey.length > 0
    ? privateKey.startsWith("0x")
      ? privateKey
      : `0x${privateKey}`
    : undefined;

export default defineConfig({
  plugins: [hardhatVerify],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      production: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    arcTestnet: {
      type: "http",
      chainType: "generic",
      chainId: 5042002,
      url: rpcUrl,
      accounts: normalizedPrivateKey ? [normalizedPrivateKey] : [],
    },
  },
  chainDescriptors: {
    5042002: {
      name: "Arc Testnet",
      chainType: "generic",
      blockExplorers: {
        etherscan: {
          name: "ArcScan",
          url: "https://testnet.arcscan.app",
          apiUrl: "https://testnet.arcscan.app/api",
        },
      },
    },
  },
  verify: {
    etherscan: {
      apiKey: process.env.ARCSCAN_API_KEY ?? "arcscan",
    },
  },
});