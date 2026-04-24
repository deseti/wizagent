import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ERC20_ABI } from "@/constants/erc20-abi";
import { WIZPAY_AGENTIC_PRO_ABI } from "@/constants/wizpay-agentic-pro-abi";
import {
  createAssignments,
  createTasks,
  validateAssignment,
  type Assignment,
  type TaskType,
} from "@/lib/agent-economy";

const DEFAULT_ARC_RPC_URLS = [
  "https://rpc.testnet.arc.network",
  "https://rpc.quicknode.testnet.arc.network",
  "https://rpc.blockdaemon.testnet.arc.network",
] as const;
const DEFAULT_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const ARCSCAN_BASE_URL = "https://testnet.arcscan.app";

export type AgentEconomyFailureCause =
  | "insufficient balance"
  | "invalid contract config"
  | "missing allowance"
  | "missing signer";

export type AgentEconomyDebug = {
  allowance: string | null;
  approvalTxHash?: Hex | null;
  balance: string | null;
  contract: string | null;
  signer: string | null;
  treasury?: string | null;
};

export type AgentEconomyExecutionResult = {
  href: string;
  task_id: string;
  txHash: Hex;
};

export type AgentEconomyStreamEvent =
  | {
      debug: AgentEconomyDebug;
      total: number;
      type: "debug";
    }
  | {
      message: string;
      progress: number;
      task_id?: string;
      total: number;
      txHash?: Hex;
      type: "status";
    }
  | {
      progress: number;
      result: AgentEconomyExecutionResult;
      total: number;
      type: "result";
    }
  | {
      debug: AgentEconomyDebug;
      progress: number;
      total: number;
      type: "done";
    }
  | {
      cause: AgentEconomyFailureCause;
      debug: AgentEconomyDebug;
      error: string;
      progress: number;
      task_id?: string;
      total: number;
      type: "error";
    };

type ExecuteAgentEconomyInput = {
  agents: unknown;
  onEvent: (event: AgentEconomyStreamEvent) => Promise<void> | void;
  taskCount: number;
};

type ExecutableAssignment = Assignment & {
  task_type: TaskType;
  wallet: Address;
};

type SendTransactionResult = {
  hash: Hex;
};

function normalizePrivateKey(value: string) {
  const trimmedValue = value.trim().replace(/^["']|["']$/g, "");
  const normalizedValue = trimmedValue.startsWith("0x")
    ? trimmedValue
    : `0x${trimmedValue}`;

  if (!/^0x[a-fA-F0-9]{64}$/u.test(normalizedValue)) {
    throw new Error("ARC_DEPLOYER_PRIVATE_KEY must be a 32-byte hex value.");
  }

  return normalizedValue as Hex;
}

function buildArcRpcUrls() {
  const configuredUrls = [
    process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URLS,
    process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL,
    process.env.ARC_TESTNET_RPC_URL,
  ]
    .flatMap((value) =>
      (value ?? "")
        .split(/[\s,]+/u)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
    .filter(Boolean);

  const urls = Array.from(
    new Set(
      configuredUrls.length > 0 ? configuredUrls : [...DEFAULT_ARC_RPC_URLS]
    )
  );

  return [
    "https://rpc.quicknode.testnet.arc.network",
    "https://rpc.blockdaemon.testnet.arc.network",
    ...urls.filter(
      (url) =>
        url !== "https://rpc.quicknode.testnet.arc.network" &&
        url !== "https://rpc.blockdaemon.testnet.arc.network"
    ),
  ].filter((url, index, collection) => collection.indexOf(url) === index);
}

function buildArcChain(rpcUrls: string[]) {
  return defineChain({
    id: 5_042_002,
    name: "Arc Testnet",
    nativeCurrency: {
      name: "USDC",
      symbol: "USDC",
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: rpcUrls,
      },
      public: {
        http: rpcUrls,
      },
    },
    blockExplorers: {
      default: {
        name: "ArcScan",
        url: ARCSCAN_BASE_URL,
      },
    },
    testnet: true,
  });
}

function classifyFailureCause(
  error: unknown,
  allowanceWasInsufficient: boolean
): AgentEconomyFailureCause {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes("private key") ||
    normalizedMessage.includes("signer") ||
    normalizedMessage.includes("account")
  ) {
    return "missing signer";
  }

  if (
    normalizedMessage.includes("insufficient balance") ||
    normalizedMessage.includes("insufficient funds")
  ) {
    return "insufficient balance";
  }

  if (
    allowanceWasInsufficient ||
    normalizedMessage.includes("allowance") ||
    normalizedMessage.includes("approve")
  ) {
    return "missing allowance";
  }

  return "invalid contract config";
}

function waitFor(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getConfiguredContractAddress() {
  return (
    process.env.WIZPAY_AGENTIC_PRO_ADDRESS ??
    process.env.NEXT_PUBLIC_WIZPAY_AGENTIC_PRO_ADDRESS ??
    process.env.WIZPAY_AGENTIC_PRO_CONTRACT_ADDRESS ??
    process.env.NEXT_PUBLIC_WIZPAY_AGENTIC_PRO_CONTRACT_ADDRESS ??
    null
  );
}

function getConfiguredTreasuryAddress() {
  return (
    process.env.WIZPAY_TREASURY_ADDRESS ??
    process.env.NEXT_PUBLIC_WIZPAY_TREASURY_ADDRESS ??
    null
  );
}

function buildExecutableAssignments(taskCount: number, agents: unknown) {
  const tasks = createTasks({ task_count: taskCount }).tasks;
  const assignments = createAssignments({
    agents,
    tasks,
  }).assignments;

  return assignments.map((assignment, index) => {
    const taskType = tasks[index]?.type;

    if (!taskType) {
      throw new Error(`Missing generated task type for ${assignment.task_id}.`);
    }

    const validation = validateAssignment({
      assignment,
      task_type: taskType,
    });

    if (!validation.approved) {
      throw new Error(
        `Assignment validation failed for ${assignment.task_id}: ${validation.reason}`
      );
    }

    return {
      ...assignment,
      task_type: taskType,
      wallet: assignment.wallet as Address,
    } satisfies ExecutableAssignment;
  });
}

async function collectDebugState({
  accountAddress,
  approvalTxHash,
  contractAddress,
  decimals,
  publicClient,
  treasury,
  usdcAddress,
}: {
  accountAddress: Address;
  approvalTxHash?: Hex | null;
  contractAddress: Address;
  decimals: number;
  publicClient: ReturnType<typeof createPublicClient>;
  treasury?: Address | null;
  usdcAddress: Address;
}) {
  const { allowance, balance } = await readTokenState({
    accountAddress,
    contractAddress,
    publicClient,
    usdcAddress,
  });

  return {
    allowance: formatUnits(allowance, decimals),
    ...(approvalTxHash ? { approvalTxHash } : {}),
    balance: formatUnits(balance, decimals),
    contract: contractAddress,
    signer: accountAddress,
    ...(treasury ? { treasury } : {}),
  } satisfies AgentEconomyDebug;
}

async function readTokenState({
  accountAddress,
  contractAddress,
  publicClient,
  usdcAddress,
}: {
  accountAddress: Address;
  contractAddress: Address;
  publicClient: ReturnType<typeof createPublicClient>;
  usdcAddress: Address;
}) {
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [accountAddress],
    }),
    publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [accountAddress, contractAddress],
    }),
  ]);

  return {
    allowance,
    balance,
  };
}

async function sendWithFallback({
  account,
  chain,
  data,
  rpcUrls,
  to,
}: {
  account: ReturnType<typeof privateKeyToAccount>;
  chain: ReturnType<typeof buildArcChain>;
  data: Hex;
  rpcUrls: string[];
  to: Address;
}) {
  let lastError: unknown = null;

  for (const rpcUrl of rpcUrls) {
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl, {
        timeout: 20_000,
      }),
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, {
        timeout: 20_000,
      }),
    });

    try {
      const hash = await walletClient.sendTransaction({
        account,
        chain,
        data,
        to,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      if (receipt.status !== "success") {
        throw new Error(`Transaction ${hash} reverted on ${rpcUrl}.`);
      }

      return {
        hash,
      } satisfies SendTransactionResult;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const normalizedMessage = message.toLowerCase();

      if (
        normalizedMessage.includes("txpool is full") ||
        normalizedMessage.includes("timed out") ||
        normalizedMessage.includes("timeout") ||
        normalizedMessage.includes("502") ||
        normalizedMessage.includes("503") ||
        normalizedMessage.includes("504")
      ) {
        continue;
      }

      throw error;
    }
  }

  throw lastError ?? new Error("All Arc RPC send attempts failed.");
}

export async function executeAgentEconomy({
  agents,
  onEvent,
  taskCount,
}: ExecuteAgentEconomyInput) {
  const rpcUrls = buildArcRpcUrls();
  const chain = buildArcChain(rpcUrls);
  const primaryPublicClient = createPublicClient({
    chain,
    transport: http(rpcUrls[0], {
      timeout: 20_000,
    }),
  });
  const usdcAddressValue = process.env.WIZPAY_USDC_ADDRESS ?? DEFAULT_USDC_ADDRESS;
  let signerAccount: ReturnType<typeof privateKeyToAccount> | null = null;
  let contractAddress: Address | null = null;
  let usdcAddress: Address | null = null;
  let totalTaskCount =
    Number.isFinite(taskCount) && taskCount > 0 ? Math.trunc(taskCount) : 50;
  let approvalTxHash: Hex | null = null;
  let progress = 0;
  let currentTaskId: string | undefined;
  let allowanceWasInsufficient = false;

  try {
    const configuredContractAddress = getConfiguredContractAddress();

    if (!configuredContractAddress || !isAddress(configuredContractAddress)) {
      throw new Error("WizPayAgenticPro contract address is missing or invalid.");
    }

    if (!isAddress(usdcAddressValue)) {
      throw new Error("USDC token address is missing or invalid.");
    }

    const signerKey = process.env.ARC_DEPLOYER_PRIVATE_KEY ?? "";
    if (!signerKey.trim()) {
      throw new Error(
        "Missing required environment variable: ARC_DEPLOYER_PRIVATE_KEY"
      );
    }

    const normalizedPrivateKey = normalizePrivateKey(signerKey);
    signerAccount = privateKeyToAccount(normalizedPrivateKey);
    contractAddress = configuredContractAddress as Address;
    usdcAddress = usdcAddressValue as Address;

    const executableAssignments = buildExecutableAssignments(taskCount, agents);
    totalTaskCount = executableAssignments.length;

    const [decimalsValue, contractTreasury] = await Promise.all([
      primaryPublicClient.readContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
      primaryPublicClient.readContract({
        address: contractAddress,
        abi: WIZPAY_AGENTIC_PRO_ABI,
        functionName: "treasury",
      }),
    ]);
    const decimals = Number(decimalsValue);
    const configuredTreasuryAddress = getConfiguredTreasuryAddress();

    if (
      configuredTreasuryAddress &&
      configuredTreasuryAddress.toLowerCase() !== contractTreasury.toLowerCase()
    ) {
      throw new Error(
        `Configured treasury ${configuredTreasuryAddress} does not match contract treasury ${contractTreasury}.`
      );
    }

    const uniqueWallets = Array.from(
      new Set(executableAssignments.map((assignment) => assignment.wallet.toLowerCase()))
    );
    const perWalletChargeEntries = await Promise.all(
      uniqueWallets.map(async (wallet) => {
        const preview = await primaryPublicClient.readContract({
          address: contractAddress,
          abi: WIZPAY_AGENTIC_PRO_ABI,
          functionName: "previewBatchCost",
          args: [[wallet as Address]],
        });

        return [wallet, preview[0]] as const;
      })
    );
    const perWalletCharge = new Map(perWalletChargeEntries);
    const totalRequiredBalance = executableAssignments.reduce((total, assignment) => {
      const nextCharge = perWalletCharge.get(assignment.wallet.toLowerCase());

      if (typeof nextCharge === "undefined") {
        throw new Error(`Missing preview charge for ${assignment.wallet}.`);
      }

      return total + nextCharge;
    }, 0n);

    await onEvent({
      message:
        "Agent economy lane armed. 50 tasks will fan out into 50 separate on-chain transactions.",
      progress,
      total: totalTaskCount,
      type: "status",
    });

    let debugState = await collectDebugState({
      accountAddress: signerAccount.address,
      contractAddress,
      decimals,
      publicClient: primaryPublicClient,
      treasury: contractTreasury,
      usdcAddress,
    });

    await onEvent({
      debug: debugState,
      total: totalTaskCount,
      type: "debug",
    });

    const {
      allowance: currentAllowance,
      balance: currentBalance,
    } = await readTokenState({
      accountAddress: signerAccount.address,
      contractAddress,
      publicClient: primaryPublicClient,
      usdcAddress,
    });

    if (currentBalance < totalRequiredBalance) {
      throw new Error(
        `Insufficient balance: signer has ${debugState.balance ?? "0"} USDC but needs ${formatUnits(totalRequiredBalance, decimals)} USDC.`
      );
    }

    if (currentAllowance < totalRequiredBalance) {
      allowanceWasInsufficient = true;

      await onEvent({
        message:
          "Allowance is below the required total. Sending a single approval transaction before task execution begins.",
        progress,
        total: totalTaskCount,
        type: "status",
      });

      const approvalData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [contractAddress, totalRequiredBalance],
      });
      const approvalResult = await sendWithFallback({
        account: signerAccount,
        chain,
        data: approvalData,
        rpcUrls,
        to: usdcAddress,
      });

      approvalTxHash = approvalResult.hash;
      debugState = await collectDebugState({
        accountAddress: signerAccount.address,
        approvalTxHash,
        contractAddress,
        decimals,
        publicClient: primaryPublicClient,
        treasury: contractTreasury,
        usdcAddress,
      });

      await onEvent({
        message: `Allowance ready on-chain with approval ${approvalTxHash}.`,
        progress,
        total: totalTaskCount,
        txHash: approvalTxHash,
        type: "status",
      });

      const { allowance: remainingAllowance } = await readTokenState({
        accountAddress: signerAccount.address,
        contractAddress,
        publicClient: primaryPublicClient,
        usdcAddress,
      });

      if (remainingAllowance < totalRequiredBalance) {
        throw new Error(
          `Allowance is still below the required total after approval: ${debugState.allowance ?? "0"} USDC.`
        );
      }
    }

    const results: AgentEconomyExecutionResult[] = [];

    for (const [index, assignment] of executableAssignments.entries()) {
      currentTaskId = assignment.task_id;

      await onEvent({
        message: `${assignment.task_id} is being dispatched as its own Arc transaction.`,
        progress,
        task_id: assignment.task_id,
        total: totalTaskCount,
        type: "status",
      });

      const taskHash = keccak256(
        stringToHex(
          `wizagent:${assignment.task_id}:${assignment.task_type}:${assignment.wallet}:${Date.now()}:${index}`
        )
      );
      const callData = encodeFunctionData({
        abi: WIZPAY_AGENTIC_PRO_ABI,
        functionName: "batchPayAgents",
        args: [[assignment.wallet], [taskHash], contractTreasury],
      });
      const paymentResult = await sendWithFallback({
        account: signerAccount,
        chain,
        data: callData,
        rpcUrls,
        to: contractAddress,
      });

      progress = index + 1;
      const result = {
        href: `${ARCSCAN_BASE_URL}/tx/${paymentResult.hash}`,
        task_id: assignment.task_id,
        txHash: paymentResult.hash,
      } satisfies AgentEconomyExecutionResult;

      results.push(result);

      await onEvent({
        progress,
        result,
        total: totalTaskCount,
        type: "result",
      });

      if (index < executableAssignments.length - 1) {
        await onEvent({
          message: "Holding for 1 second before the next task transaction.",
          progress,
          total: totalTaskCount,
          type: "status",
        });
        await waitFor(1_000);
      }
    }

    const finalDebugState = await collectDebugState({
      accountAddress: signerAccount.address,
      approvalTxHash,
      contractAddress,
      decimals,
      publicClient: primaryPublicClient,
      treasury: contractTreasury,
      usdcAddress,
    });

    await onEvent({
      debug: finalDebugState,
      progress,
      total: totalTaskCount,
      type: "done",
    });

    return {
      debug: finalDebugState,
      results,
    };
  } catch (error) {
    const fallbackDebugState = {
      allowance: null,
      ...(approvalTxHash ? { approvalTxHash } : {}),
      balance: null,
      contract: contractAddress,
      signer: signerAccount?.address ?? null,
    } satisfies AgentEconomyDebug;
    const debugState =
      signerAccount && contractAddress && usdcAddress
        ? await (async () => {
            const decimals = Number(
              await primaryPublicClient
                .readContract({
                  address: usdcAddress,
                  abi: ERC20_ABI,
                  functionName: "decimals",
                })
                .catch(() => 6)
            );

            return collectDebugState({
              accountAddress: signerAccount.address,
              approvalTxHash,
              contractAddress,
              decimals,
              publicClient: primaryPublicClient,
              usdcAddress,
            }).catch(() => fallbackDebugState);
          })()
        : fallbackDebugState;

    await onEvent({
      cause: classifyFailureCause(error, allowanceWasInsufficient),
      debug: debugState,
      error: error instanceof Error ? error.message : "Unexpected agent economy error.",
      progress,
      ...(currentTaskId ? { task_id: currentTaskId } : {}),
      total: totalTaskCount,
      type: "error",
    });

    throw error;
  }
}
