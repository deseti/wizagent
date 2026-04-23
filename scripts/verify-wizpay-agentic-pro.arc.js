import fs from "node:fs";
import path from "node:path";

import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import hre from "hardhat";
import { parseUnits } from "viem";

const ROOT_DIR = process.cwd();
const DEFAULT_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const DEFAULT_STABLE_FX_ADAPTER_ADDRESS =
  "0x400d3935B904cbdB6B5eb2Fd50E6843f1b0AD8d6";
const DEFAULT_CONTRACT_ADDRESS = "0xc443367fddbd617436ea0842f118a3a5dee9982f";
const ARCSCAN_API_URL = "https://testnet.arcscan.app/api";

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

function buildConstructorArgs(defaultOwner) {
  const ownerAddress = getEnv("WIZPAY_OWNER_ADDRESS", defaultOwner);
  const treasuryAddress = requireEnv("WIZPAY_TREASURY_ADDRESS", ownerAddress);
  const tokenDecimals = Number.parseInt(getEnv("WIZPAY_TOKEN_DECIMALS", "18"), 10);
  const paymentAmount = parseUnits(
    getEnv("WIZPAY_PAYMENT_AMOUNT", "0.001"),
    tokenDecimals
  );

  return [
    ownerAddress,
    getEnv("WIZPAY_USDC_ADDRESS", DEFAULT_USDC_ADDRESS),
    requireEnv("WIZPAY_EURC_ADDRESS"),
    getEnv("WIZPAY_STABLE_FX_ADAPTER_ADDRESS", DEFAULT_STABLE_FX_ADAPTER_ADDRESS),
    treasuryAddress,
    paymentAmount,
    BigInt(getEnv("WIZPAY_TREASURY_FEE_BPS", "30")),
    BigInt(getEnv("WIZPAY_MAX_SLIPPAGE_BPS", "50")),
  ];
}

async function resolveExplorerVerification(address) {
  const url = `${ARCSCAN_API_URL}?${new URLSearchParams({
    module: "contract",
    action: "getsourcecode",
    address,
  }).toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ArcScan verification lookup failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const result = Array.isArray(payload?.result) ? payload.result[0] : null;

  if (
    payload?.status === "1" &&
    result &&
    typeof result.SourceCode === "string" &&
    result.SourceCode.length > 0 &&
    typeof result.ABI === "string" &&
    result.ABI !== "Contract source code not verified"
  ) {
    return {
      compilerVersion: result.CompilerVersion,
      contractName: result.ContractName,
      fileName: result.FileName,
    };
  }

  return null;
}

async function main() {
  loadEnvFile(path.resolve(ROOT_DIR, ".env.local"));
  loadEnvFile(path.resolve(ROOT_DIR, ".env"));

  const contractAddress =
    process.env.WIZPAY_AGENTIC_PRO_ADDRESS ??
    process.env.NEXT_PUBLIC_WIZPAY_AGENTIC_PRO_ADDRESS ??
    DEFAULT_CONTRACT_ADDRESS;
  const defaultOwner = process.env.ARC_DEPLOYER_ADDRESS ?? "0x32F251fc36A1174901124589EAC2d4E391816F69";
  const constructorArgs = buildConstructorArgs(defaultOwner);

  try {
    await verifyContract(
      {
        address: contractAddress,
        contract: "contracts/WizPayAgenticPro.sol:WizPayAgenticPro",
        constructorArgs,
        provider: "etherscan",
      },
      hre,
    );

    console.log(`ArcScan verification completed for ${contractAddress}.`);
  } catch (error) {
    const explorerVerification = await resolveExplorerVerification(contractAddress).catch(
      () => null
    );

    if (explorerVerification) {
      console.warn(
        `Hardhat verify reported a failure, but ArcScan already exposes verified source and ABI for ${contractAddress}.`
      );
      console.log(
        `ArcScan contract: ${explorerVerification.contractName} (${explorerVerification.compilerVersion}) from ${explorerVerification.fileName}.`
      );
      return;
    }

    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});