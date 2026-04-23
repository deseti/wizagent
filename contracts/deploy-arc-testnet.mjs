import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CONTRACT_PATH = path.resolve(__dirname, "WizPayAgenticPro.sol");

const DEFAULT_ARC_RPC_URL = "https://rpc.testnet.arc.network";
const DEFAULT_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const DEFAULT_STABLE_FX_ADAPTER_ADDRESS =
  "0x400d3935B904cbdB6B5eb2Fd50E6843f1b0AD8d6";

const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [DEFAULT_ARC_RPC_URL],
    },
    public: {
      http: [DEFAULT_ARC_RPC_URL],
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

function getEnv(name, fallback = undefined) {
  const value = process.env[name];
  if (value !== undefined && value !== "") {
    return value;
  }

  return fallback;
}

function requireEnv(name, fallback = undefined) {
  const value = getEnv(name, fallback);
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function compileContract() {
  const source = fs.readFileSync(CONTRACT_PATH, "utf8");
  const input = {
    language: "Solidity",
    sources: {
      "WizPayAgenticPro.sol": {
        content: source,
      },
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = output.errors ?? [];
  const fatalErrors = errors.filter((entry) => entry.severity === "error");
  if (fatalErrors.length > 0) {
    throw new Error(
      fatalErrors.map((entry) => entry.formattedMessage).join("\n\n")
    );
  }

  const contract = output.contracts["WizPayAgenticPro.sol"].WizPayAgenticPro;
  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
  };
}

function buildConstructorArgs(deployerAddress, { allowPlaceholderEurc = false } = {}) {
  const ownerAddress = getEnv("WIZPAY_OWNER_ADDRESS", deployerAddress);
  const treasuryAddress = requireEnv(
    "WIZPAY_TREASURY_ADDRESS",
    ownerAddress
  );
  const tokenDecimals = Number.parseInt(getEnv("WIZPAY_TOKEN_DECIMALS", "18"), 10);
  const paymentAmount = parseUnits(
    getEnv("WIZPAY_PAYMENT_AMOUNT", "0.001"),
    tokenDecimals
  );

  return [
    ownerAddress,
    getEnv("WIZPAY_USDC_ADDRESS", DEFAULT_USDC_ADDRESS),
    requireEnv(
      "WIZPAY_EURC_ADDRESS",
      allowPlaceholderEurc
        ? "0x0000000000000000000000000000000000000001"
        : undefined
    ),
    getEnv(
      "WIZPAY_STABLE_FX_ADAPTER_ADDRESS",
      DEFAULT_STABLE_FX_ADAPTER_ADDRESS
    ),
    treasuryAddress,
    paymentAmount,
    BigInt(getEnv("WIZPAY_TREASURY_FEE_BPS", "30")),
    BigInt(getEnv("WIZPAY_MAX_SLIPPAGE_BPS", "50")),
  ];
}

async function main() {
  loadEnvFile(path.resolve(ROOT_DIR, ".env.local"));
  loadEnvFile(path.resolve(ROOT_DIR, ".env"));

  const dryRun = process.argv.includes("--dry-run");
  const rpcUrl = getEnv(
    "ARC_TESTNET_RPC_URL",
    getEnv("NEXT_PUBLIC_ARC_TESTNET_RPC_URL", DEFAULT_ARC_RPC_URL)
  );

  const { abi, bytecode } = compileContract();
  console.log(`Compiled WizPayAgenticPro (${bytecode.length / 2 - 1} bytes of bytecode).`);

  if (dryRun) {
    const previewOwner = getEnv(
      "WIZPAY_OWNER_ADDRESS",
      "0x000000000000000000000000000000000000dEaD"
    );
    const args = buildConstructorArgs(previewOwner, { allowPlaceholderEurc: true });
    console.log("Dry run constructor args:");
    console.log(JSON.stringify(args, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2));
    return;
  }

  const deployerKey = normalizePrivateKey(requireEnv("ARC_DEPLOYER_PRIVATE_KEY"));
  const account = privateKeyToAccount(deployerKey);
  const args = buildConstructorArgs(account.address);

  const publicClient = createPublicClient({
    chain: {
      ...arcTestnet,
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    },
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: {
      ...arcTestnet,
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    },
    transport: http(rpcUrl),
  });

  console.log(`Deploying from ${account.address} to Arc Testnet via ${rpcUrl} ...`);
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args,
  });

  console.log(`Broadcasted deployment tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error("Deployment completed without a contractAddress in the receipt.");
  }

  console.log(`WizPayAgenticPro deployed at: ${receipt.contractAddress}`);
  console.log(
    `ArcScan: ${arcTestnet.blockExplorers.default.url}/address/${receipt.contractAddress}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});