"use client";

import {
  useCallback,
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  encodeFunctionData,
  formatUnits,
  isAddress,
  keccak256,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { usePublicClient } from "wagmi";

import { ERC20_ABI } from "@/constants/erc20-abi";
import { USDC_ADDRESS } from "@/constants/addresses";
import { WIZPAY_AGENTIC_PRO_ABI } from "@/constants/wizpay-agentic-pro-abi";
import { useCircleW3S } from "@/hooks/useCircleW3S";
import { arcTestnet } from "@/lib/wagmi";

type LogTone = "matrix" | "cyan" | "amber" | "muted";

type LogEntry = {
  id: string;
  tag: string;
  message: string;
  tone: LogTone;
  href?: string;
  hrefLabel?: string;
};

type ActivePayrollExecution = {
  executionId: number;
  expectedAgentCount: number;
  observedTaskHashes: Set<Hex>;
  payer: Address;
  seenEventKeys: Set<string>;
  taskHashes: Set<Hex>;
  txHash: Hex | null;
};

type SmartPastePayload = {
  token: string;
  key: string;
  walletId: string;
  treasuryAddress?: string;
};

type HackerTerminalProps = {
  chainId: number;
  chainName: string;
  contractAddress: string;
  initialTreasuryAddress?: string;
  rpcUrl: string;
  stableFxAdapterAddress: string;
};

const MAX_LOG_LINES = 120;
const ARCSCAN_BASE_URL = arcTestnet.blockExplorers.default.url;
const DEFAULT_USDC_DECIMALS = 6;
const DEFAULT_APPROVAL_WHOLE_UNITS = 1_000_000n;
const CUSTOM_TREASURY_ROUTE_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_CUSTOM_TREASURY_ROUTE === "true";

const divisions = [
  {
    id: "DIV-01",
    name: "Signal Hunters",
    description: "Task intake, duplicate trap, and payroll queue formation.",
    status: "50 task hashes primed",
  },
  {
    id: "DIV-02",
    name: "Validation Mesh",
    description: "Anti-spam screening and settlement policy enforcement.",
    status: "taskHash shield active",
  },
  {
    id: "DIV-03",
    name: "Translator (EURC)",
    description: "Cross-currency routing for agents that require EURC settlement.",
    status: "fx lanes and LP fee taps armed",
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSmartPastePayload(value: unknown): value is SmartPastePayload {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.token === "string" &&
    typeof value.key === "string" &&
    typeof value.walletId === "string" &&
    (typeof value.treasuryAddress === "undefined" ||
      typeof value.treasuryAddress === "string")
  );
}

function getNestedString(source: unknown, path: string[]) {
  let current: unknown = source;

  for (const key of path) {
    if (!isRecord(current) || typeof current[key] === "undefined") {
      return null;
    }

    current = current[key];
  }

  return typeof current === "string" && current ? current : null;
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function waitFor(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatAmount(
  amount: bigint,
  decimals: number,
  minimumFractionDigits: number,
  maximumFractionDigits = minimumFractionDigits
) {
  const [whole, rawFraction = ""] = formatUnits(amount, decimals).split(".");

  const paddedFraction = rawFraction.padEnd(minimumFractionDigits, "0");
  const trimmedFraction = paddedFraction.slice(0, maximumFractionDigits);
  const compactFraction =
    maximumFractionDigits === minimumFractionDigits
      ? trimmedFraction
      : trimmedFraction.replace(/0+$/, "");

  return compactFraction ? `${whole}.${compactFraction}` : whole;
}

function shortenAddress(address: string) {
  if (address.length < 12) {
    return address;
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function createLogId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function extractTxHash(result: unknown) {
  const txHash =
    getNestedString(result, ["data", "txHash"]) ??
    getNestedString(result, ["txHash"]) ??
    getNestedString(result, ["transactionHash"]);

  return txHash && txHash.startsWith("0x") ? (txHash as Hex) : null;
}

function extractTransactionId(result: unknown) {
  return (
    getNestedString(result, ["data", "transactionId"]) ??
    getNestedString(result, ["transactionId"]) ??
    getNestedString(result, ["transaction", "id"]) ??
    getNestedString(result, ["transaction", "transactionId"])
  );
}

function buildBatchPayload(walletAddress: Address, runSalt: string) {
  const agents = Array.from({ length: 50 }, () => walletAddress);
  const taskHashes = Array.from({ length: 50 }, (_, index) =>
    keccak256(stringToHex(`wizpay:${walletAddress}:${runSalt}:${index + 1}`))
  );

  return {
    agents,
    taskHashes,
  };
}

function shortenHex(value: string) {
  if (value.length < 18) {
    return value;
  }

  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function buildBootLogs(contractAddress: string): LogEntry[] {
  return [
    {
      id: createLogId(),
      tag: "BOOT",
      message: "WizPay hacker terminal online. Three AI divisions and Treasury-Bot linked.",
      tone: "matrix",
    },
    {
      id: createLogId(),
      tag: "ARC",
      message: "Arc Testnet control plane synced for sponsored execution.",
      tone: "cyan",
    },
    {
      id: createLogId(),
      tag: "ROUTER",
      message: `Payroll router detected at ${contractAddress}.`,
      tone: "matrix",
    },
    {
      id: createLogId(),
      tag: "GAS",
      message: "Gas Fee: $0.00 (ERC-4337 Sponsored)",
      tone: "cyan",
    },
    {
      id: createLogId(),
      tag: "READY",
      message:
        "Awaiting Circle auth. Use the click controls to sync wallet, approve USDC, and run payroll.",
      tone: "muted",
    },
  ];
}

export function HackerTerminal({
  chainId,
  chainName,
  contractAddress,
  initialTreasuryAddress = "",
  rpcUrl,
  stableFxAdapterAddress,
}: HackerTerminalProps) {
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const {
    clearSession,
    createContractExecutionChallenge,
    error,
    executeChallenge,
    getChallengeTransactionStatus,
    initializeUser,
    listWallets,
    ready,
    session,
    setSession,
    status,
  } = useCircleW3S();
  const [logs, setLogs] = useState<LogEntry[]>(() => buildBootLogs(contractAddress));
  const deferredLogs = useDeferredValue(logs);
  const [isRunning, setIsRunning] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [userTokenInput, setUserTokenInput] = useState(() => session?.userToken ?? "");
  const [encryptionKeyInput, setEncryptionKeyInput] = useState(
    () => session?.encryptionKey ?? ""
  );
  const [walletIdInput, setWalletIdInput] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletUsdcBalance, setWalletUsdcBalance] = useState<bigint | null>(null);
  const [treasuryAddress, setTreasuryAddress] = useState(() => initialTreasuryAddress.trim());
  const [contractTreasuryAddress, setContractTreasuryAddress] = useState("");
  const [isApprovingAllowance, setIsApprovingAllowance] = useState(false);
  const [isSmartPasting, setIsSmartPasting] = useState(false);
  const [isInjectionGlowActive, setIsInjectionGlowActive] = useState(false);
  const [treasuryBalance, setTreasuryBalance] = useState<bigint | null>(null);
  const [usdcDecimals, setUsdcDecimals] = useState(DEFAULT_USDC_DECIMALS);
  const [sessionFeeLift, setSessionFeeLift] = useState<bigint>(0n);
  const [lastTxHash, setLastTxHash] = useState<Hex | null>(null);
  const [lastGrossCharge, setLastGrossCharge] = useState<bigint | null>(null);
  const executionRef = useRef(0);
  const activeExecutionRef = useRef<ActivePayrollExecution | null>(null);
  const glowTimeoutRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const explorerLink = lastTxHash ? `${ARCSCAN_BASE_URL}/tx/${lastTxHash}` : null;
  const payrollRouterAddress = isAddress(contractAddress)
    ? (contractAddress as Address)
    : null;
  const envTreasuryAddress = initialTreasuryAddress.trim();
  const displayedTreasuryAddress = CUSTOM_TREASURY_ROUTE_ENABLED
    ? treasuryAddress.trim() || contractTreasuryAddress.trim() || envTreasuryAddress
    : contractTreasuryAddress.trim() || envTreasuryAddress || treasuryAddress.trim();
  const approvalAmount = DEFAULT_APPROVAL_WHOLE_UNITS * 10n ** BigInt(usdcDecimals);

  const refreshTreasuryBalance = useCallback(async () => {
    if (!publicClient || !displayedTreasuryAddress || !isAddress(displayedTreasuryAddress)) {
      setTreasuryBalance(null);
      return;
    }

    try {
      const nextBalance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [displayedTreasuryAddress as Address],
      });

      setTreasuryBalance(nextBalance);
    } catch {
      setTreasuryBalance(null);
    }
  }, [displayedTreasuryAddress, publicClient]);

  useEffect(() => {
    return () => {
      executionRef.current += 1;
      activeExecutionRef.current = null;

      if (glowTimeoutRef.current !== null) {
        window.clearTimeout(glowTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [deferredLogs]);

  useEffect(() => {
    let cancelled = false;

    async function loadTreasuryAddress() {
      if (!publicClient || !payrollRouterAddress) {
        return;
      }

      try {
        const nextTreasuryAddress = await publicClient.readContract({
          address: payrollRouterAddress,
          abi: WIZPAY_AGENTIC_PRO_ABI,
          functionName: "treasury",
        });

        if (!cancelled) {
          setContractTreasuryAddress(nextTreasuryAddress);
        }
      } catch {
        if (!cancelled) {
          setContractTreasuryAddress("");
        }
      }
    }

    void loadTreasuryAddress();

    return () => {
      cancelled = true;
    };
  }, [payrollRouterAddress, publicClient]);

  useEffect(() => {
    let cancelled = false;

    async function loadUsdcDecimals() {
      if (!publicClient) {
        return;
      }

      try {
        const nextDecimals = await publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "decimals",
        });

        if (!cancelled) {
          setUsdcDecimals(Number(nextDecimals));
        }
      } catch {
        if (!cancelled) {
          setUsdcDecimals(DEFAULT_USDC_DECIMALS);
        }
      }
    }

    void loadUsdcDecimals();

    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => {
      void refreshTreasuryBalance();
    }, 0);

    return () => {
      window.clearTimeout(refreshTimer);
    };
  }, [refreshTreasuryBalance, runCount]);

  const appendLog = useCallback((entry: Omit<LogEntry, "id">) => {
    startTransition(() => {
      setLogs((currentLogs) => [
        ...currentLogs.slice(-(MAX_LOG_LINES - 1)),
        {
          id: createLogId(),
          ...entry,
        },
      ]);
    });
  }, []);

  const recordAgentPaidEvent = useCallback(
    ({
      agent,
      logIndex,
      settlementAmount,
      settlementToken,
      taskHash,
      transactionHash,
      treasuryFee,
    }: {
      agent: Address;
      logIndex: bigint | number | null | undefined;
      settlementAmount: bigint;
      settlementToken: Address;
      taskHash: Hex;
      transactionHash: Hex | null;
      treasuryFee: bigint;
    }) => {
      const activeExecution = activeExecutionRef.current;
      if (!activeExecution || !activeExecution.taskHashes.has(taskHash)) {
        return false;
      }

      if (
        activeExecution.txHash !== null &&
        transactionHash !== null &&
        activeExecution.txHash !== transactionHash
      ) {
        return false;
      }

      const eventKey = `${transactionHash ?? "pending"}:${String(logIndex ?? -1)}:${taskHash}`;
      if (activeExecution.seenEventKeys.has(eventKey)) {
        return false;
      }

      activeExecution.seenEventKeys.add(eventKey);
      activeExecution.observedTaskHashes.add(taskHash);

      if (transactionHash !== null) {
        activeExecution.txHash = transactionHash;
        setLastTxHash(transactionHash);
      }

      if (treasuryFee > 0n) {
        setSessionFeeLift((current) => current + treasuryFee);
      }

      const settlementLabel =
        settlementToken.toLowerCase() === USDC_ADDRESS.toLowerCase() ? "USDC" : "EURC";

      appendLog({
        tag: `EVENT-${String(activeExecution.observedTaskHashes.size).padStart(2, "0")}`,
        message:
          settlementLabel === "USDC"
            ? `AgentPaid detected on-chain for ${shortenHex(taskHash)} -> ${shortenAddress(agent)} settled ${formatAmount(settlementAmount, usdcDecimals, 6, 6)} USDC.`
            : `AgentPaid detected on-chain for ${shortenHex(taskHash)} -> ${shortenAddress(agent)} settled ${formatAmount(settlementAmount, usdcDecimals, 6, 6)} EURC and routed ${formatAmount(treasuryFee, usdcDecimals, 6, 6)} USDC treasury fee.`,
        tone: settlementLabel === "USDC" ? "matrix" : "cyan",
        href: transactionHash ? `${ARCSCAN_BASE_URL}/tx/${transactionHash}` : undefined,
        hrefLabel: transactionHash ? "Open Event TX" : undefined,
      });

      return true;
    },
    [appendLog, usdcDecimals]
  );

  useEffect(() => {
    if (!publicClient || !payrollRouterAddress) {
      return;
    }

    return publicClient.watchContractEvent({
      address: payrollRouterAddress,
      abi: WIZPAY_AGENTIC_PRO_ABI,
      eventName: "AgentPaid",
      poll: true,
      pollingInterval: 4_000,
      onLogs(nextLogs) {
        for (const log of nextLogs) {
          if ("removed" in log && log.removed) {
            continue;
          }

          const activeExecution = activeExecutionRef.current;
          if (!activeExecution) {
            continue;
          }

          const { args } = log;
          if (
            !args.taskHash ||
            !args.payer ||
            !args.agent ||
            !args.settlementToken ||
            typeof args.settlementAmount !== "bigint" ||
            typeof args.treasuryFee !== "bigint"
          ) {
            continue;
          }

          if (args.payer.toLowerCase() !== activeExecution.payer.toLowerCase()) {
            continue;
          }

          recordAgentPaidEvent({
            agent: args.agent,
            logIndex: log.logIndex,
            settlementAmount: args.settlementAmount,
            settlementToken: args.settlementToken,
            taskHash: args.taskHash,
            transactionHash: log.transactionHash ?? null,
            treasuryFee: args.treasuryFee,
          });
        }
      },
      onError(nextError) {
        if (!activeExecutionRef.current) {
          return;
        }

        appendLog({
          tag: "WATCH",
          message: `AgentPaid watcher error: ${normalizeError(nextError)}`,
          tone: "amber",
        });
      },
    });
  }, [appendLog, payrollRouterAddress, publicClient, recordAgentPaidEvent]);

  function handleSaveSession() {
    const userToken = userTokenInput.trim();
    const encryptionKey = encryptionKeyInput.trim();

    if (!userToken || !encryptionKey) {
      appendLog({
        tag: "AUTH",
        message: "Provide both Circle userToken and encryptionKey before storing the session.",
        tone: "amber",
      });
      return;
    }

    setSession({
      encryptionKey,
      userToken,
    });
    appendLog({
      tag: "AUTH",
      message: "Circle operator session stored for this browser tab.",
      tone: "cyan",
    });
  }

  function handleClearSession() {
    clearSession();
    setUserTokenInput("");
    setEncryptionKeyInput("");
    setWalletIdInput("");
    setTreasuryAddress(envTreasuryAddress);
    setWalletAddress("");
    appendLog({
      tag: "AUTH",
      message: "Circle session cleared from this browser tab.",
      tone: "muted",
    });
  }

  function triggerInjectionGlow() {
    if (glowTimeoutRef.current !== null) {
      window.clearTimeout(glowTimeoutRef.current);
    }

    setIsInjectionGlowActive(true);
    glowTimeoutRef.current = window.setTimeout(() => {
      setIsInjectionGlowActive(false);
      glowTimeoutRef.current = null;
    }, 900);
  }

  async function resolveChallengeTxHash({
    challengeId,
    initialResult,
    logContext,
    transactionId,
  }: {
    challengeId: string;
    initialResult: unknown;
    logContext: string;
    transactionId?: string | null;
  }) {
    const immediateTxHash = extractTxHash(initialResult);
    if (immediateTxHash) {
      return immediateTxHash;
    }

    const immediateTransactionId = extractTransactionId(initialResult) ?? transactionId ?? null;
    if (immediateTransactionId) {
      appendLog({
        tag: "SYSTEM",
        message: `${logContext} accepted by Circle. Transaction ${immediateTransactionId} is pending hash propagation.`,
        tone: "muted",
      });
    }

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      appendLog({
        tag: "SYSTEM",
        message: `WAITING FOR ON-CHAIN CONFIRMATION (POLLING ATTEMPT ${attempt}/5)...`,
        tone: "amber",
      });

      await waitFor(2_000);

      const statusPayload = await getChallengeTransactionStatus(
        challengeId,
        immediateTransactionId
      );
      const polledTxHash = extractTxHash(statusPayload) ??
        (statusPayload.txHash && statusPayload.txHash.startsWith("0x")
          ? (statusPayload.txHash as Hex)
          : null);

      if (polledTxHash) {
        return polledTxHash;
      }
    }

    throw new Error(
      `${logContext} was approved by Circle, but the transaction hash was still unavailable after 5 polling attempts.`
    );
  }

  async function handleSmartPaste() {
    if (isSmartPasting) {
      return;
    }

    setIsSmartPasting(true);

    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        throw new Error("Clipboard API is not available in this browser context.");
      }

      appendLog({
        tag: "ACCESS",
        message: "INCOMING ENCRYPTED PAYLOAD DETECTED...",
        tone: "cyan",
      });

      const clipboardText = await navigator.clipboard.readText();
      const parsedPayload = JSON.parse(clipboardText) as unknown;

      if (!isSmartPastePayload(parsedPayload)) {
        throw new Error(
          "Smart Paste expects JSON in the format {\"token\":\"...\",\"key\":\"...\",\"walletId\":\"...\",\"treasuryAddress\":\"0x...\"}."
        );
      }

      const token = parsedPayload.token.trim();
      const key = parsedPayload.key.trim();
      const walletId = parsedPayload.walletId.trim();
      const nextTreasuryAddress = parsedPayload.treasuryAddress?.trim() ?? "";

      if (!token || !key || !walletId) {
        throw new Error(
          "Smart Paste received an incomplete payload. token, key, and walletId are all required."
        );
      }
      if (nextTreasuryAddress && !isAddress(nextTreasuryAddress)) {
        throw new Error("Smart Paste received an invalid treasuryAddress.");
      }

      await waitFor(180);
      appendLog({
        tag: "DECRYPT",
        message: "PARSING JSON KERNEL... SUCCESS.",
        tone: "matrix",
      });

      setUserTokenInput(token);
      setEncryptionKeyInput(key);
      setWalletIdInput(walletId);
      if (CUSTOM_TREASURY_ROUTE_ENABLED && nextTreasuryAddress) {
        setTreasuryAddress(nextTreasuryAddress);
      }
      setSession({
        encryptionKey: key,
        userToken: token,
      });
      triggerInjectionGlow();

      await waitFor(220);
      appendLog({
        tag: "SYSTEM",
        message: "SESSION INJECTED. AGENTIC ENGINE READY.",
        tone: "matrix",
      });

      if (CUSTOM_TREASURY_ROUTE_ENABLED && nextTreasuryAddress) {
        await waitFor(180);
        appendLog({
          tag: "SYSTEM",
          message: `LP AGENT RE-ROUTED TO: ${nextTreasuryAddress}`,
          tone: "matrix",
        });
      } else if (nextTreasuryAddress) {
        await waitFor(180);
        appendLog({
          tag: "SYSTEM",
          message: "Custom treasury override ignored. The deployed contract treasury stays authoritative.",
          tone: "muted",
        });
      }
    } catch (nextError) {
      appendLog({
        tag: "ERROR",
        message: normalizeError(nextError),
        tone: "amber",
      });
    } finally {
      setIsSmartPasting(false);
    }
  }

  async function handleApprovePayrollAllowance() {
    if (isApprovingAllowance) {
      return;
    }

    setIsApprovingAllowance(true);

    try {
      if (!ready) {
        throw new Error("Circle Web SDK is still booting. Wait for the SDK ready indicator.");
      }
      if (!publicClient) {
        throw new Error("Arc public client is not ready.");
      }
      if (!payrollRouterAddress) {
        throw new Error("WizPayAgenticPro contract address is missing or invalid.");
      }

      ensureCircleSessionForExecution();
      const { address: operatorAddress, id: operatorWalletId } =
        await resolveOperatorWallet();
      const approvalRef = `wizagent-approve-${Date.now().toString(36)}`;

      appendLog({
        tag: "SECURITY",
        message: `Requesting persistent USDC allowance for ${shortenAddress(payrollRouterAddress)} from ${operatorAddress}.`,
        tone: "amber",
      });

      const callData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [payrollRouterAddress, approvalAmount],
      });

      const challenge = await createContractExecutionChallenge({
        walletId: operatorWalletId,
        contractAddress: USDC_ADDRESS,
        callData,
        feeLevel: "MEDIUM",
        memo: "WizPay payroll USDC approval",
        refId: approvalRef,
      });

      appendLog({
        tag: "CIRCLE",
        message: `Allowance challenge ${challenge.challengeId.slice(0, 12)}... created. Awaiting Circle approval modal.`,
        tone: "muted",
      });

      const challengeResult = await executeChallenge(challenge.challengeId);
      const txHash = await resolveChallengeTxHash({
        challengeId: challenge.challengeId,
        initialResult: challengeResult,
        logContext: "Allowance request",
        transactionId: challenge.transactionId,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status !== "success") {
        throw new Error(`USDC approval transaction ${txHash} was mined but reverted.`);
      }

      appendLog({
        tag: "SYSTEM",
        message: `USDC allowance granted for ${formatAmount(approvalAmount, usdcDecimals, 2, 2)} USDC.`,
        tone: "matrix",
        href: `${ARCSCAN_BASE_URL}/tx/${txHash}`,
        hrefLabel: "Open Approval TX",
      });
    } catch (nextError) {
      appendLog({
        tag: "ERROR",
        message: normalizeError(nextError),
        tone: "amber",
      });
    } finally {
      setIsApprovingAllowance(false);
    }
  }

  function ensureCircleSessionForExecution() {
    const userToken = userTokenInput.trim();
    const encryptionKey = encryptionKeyInput.trim();

    if (userToken && encryptionKey) {
      if (session?.userToken !== userToken || session?.encryptionKey !== encryptionKey) {
        setSession({
          encryptionKey,
          userToken,
        });
      }

      return;
    }

    if (!session?.userToken || !session.encryptionKey) {
      throw new Error(
        "Circle session is missing. Paste userToken and encryptionKey, then execute again."
      );
    }
  }

  async function resolveOperatorWallet() {
    let wallets = await listWallets();
    let arcWallets = wallets.filter(
      (wallet) => wallet.blockchain.toUpperCase() === "ARC-TESTNET"
    );

    if (arcWallets.length === 0) {
      appendLog({
        tag: "WALLET",
        message: "No ARC-TESTNET wallet found. Initializing Circle wallet set now.",
        tone: "amber",
      });

      await initializeUser();
      wallets = await listWallets();
      arcWallets = wallets.filter(
        (wallet) => wallet.blockchain.toUpperCase() === "ARC-TESTNET"
      );
    }

    const preferredWalletId = walletIdInput.trim();
    const selectedWallet = preferredWalletId
      ? arcWallets.find((wallet) => wallet.id === preferredWalletId)
      : arcWallets[0];

    if (!selectedWallet) {
      throw new Error(
        preferredWalletId
          ? `Circle wallet ${preferredWalletId} was not found on ARC-TESTNET.`
          : "Circle did not return an ARC-TESTNET wallet."
      );
    }

    if (!isAddress(selectedWallet.address)) {
      throw new Error("Circle returned a wallet with an invalid EVM address.");
    }

    setWalletIdInput(selectedWallet.id);
    setWalletAddress(selectedWallet.address);

    return {
      address: selectedWallet.address as Address,
      id: selectedWallet.id,
      wallet: selectedWallet,
    };
  }

  async function handleSyncWallet() {
    try {
      ensureCircleSessionForExecution();
      const resolvedWallet = await resolveOperatorWallet();

      appendLog({
        tag: "WALLET",
        message: `Circle ARC wallet ${resolvedWallet.id} resolved at ${resolvedWallet.address}.`,
        tone: "cyan",
      });
    } catch (nextError) {
      appendLog({
        tag: "ERROR",
        message: normalizeError(nextError),
        tone: "amber",
      });
    }
  }

  async function handleExecute() {
    if (isRunning) {
      appendLog({
        tag: "LOCK",
        message: "A payroll cycle is already live. Wait for the Arc hash before re-triggering.",
        tone: "amber",
      });
      return;
    }

    const currentExecution = executionRef.current + 1;
    executionRef.current = currentExecution;
    setIsRunning(true);
    setLastTxHash(null);
    setSessionFeeLift(0n);

    appendLog({
      tag: "EXEC",
      message: "Operator command accepted. Building the payroll request from the live on-chain preview.",
      tone: "cyan",
    });

    try {
      if (!ready) {
        throw new Error("Circle Web SDK is still booting. Wait for the SDK ready indicator.");
      }
      if (!publicClient) {
        throw new Error("Arc public client is not ready.");
      }
      if (!payrollRouterAddress) {
        throw new Error("WizPayAgenticPro contract address is missing or invalid.");
      }

      ensureCircleSessionForExecution();

      const { address: operatorAddress, id: operatorWalletId } =
        await resolveOperatorWallet();
      const runSalt = `${Date.now().toString(36)}-${runCount + 1}`;
      const { agents, taskHashes } = buildBatchPayload(operatorAddress, runSalt);
      const desiredTreasuryAddress = displayedTreasuryAddress;

      activeExecutionRef.current = {
        executionId: currentExecution,
        expectedAgentCount: agents.length,
        observedTaskHashes: new Set(),
        payer: operatorAddress,
        seenEventKeys: new Set(),
        taskHashes: new Set(taskHashes),
        txHash: null,
      };

      appendLog({
        tag: "WALLET",
        message: `Circle ARC wallet ${operatorWalletId} locked at ${operatorAddress}.`,
        tone: "muted",
      });

      if (!desiredTreasuryAddress) {
        throw new Error(
          "Treasury route is missing. Load the deployed contract treasury or provide NEXT_PUBLIC_WIZPAY_TREASURY_ADDRESS as a fallback."
        );
      }

      if (!isAddress(desiredTreasuryAddress)) {
        throw new Error("The treasury route in the terminal is not a valid EVM address.");
      }

      appendLog({
        tag: "TREASURY",
        message: `Treasury route locked to ${desiredTreasuryAddress} for this payroll batch.`,
        tone: "cyan",
      });

      const [preview, allowance, operatorUsdcBalance] = await Promise.all([
        publicClient.readContract({
          address: payrollRouterAddress,
          abi: WIZPAY_AGENTIC_PRO_ABI,
          functionName: "previewBatchCost",
          args: [agents],
        }),
        publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [operatorAddress, payrollRouterAddress],
        }),
        publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [operatorAddress],
        }),
      ]);

      const [grossCharge, swapCount, treasuryFeeTotal] = preview;
      setLastGrossCharge(grossCharge);
      setWalletUsdcBalance(operatorUsdcBalance);

      appendLog({
        tag: "QUOTE",
        message:
          treasuryFeeTotal > 0n
            ? `On-chain preview requires ${formatAmount(grossCharge, usdcDecimals, 6, 6)} USDC with ${swapCount.toString()} routed FX leg(s) and ${formatAmount(treasuryFeeTotal, usdcDecimals, 6, 6)} USDC treasury fee.`
            : `On-chain preview requires ${formatAmount(grossCharge, usdcDecimals, 6, 6)} USDC with no extra FX treasury surcharge.`,
        tone: "cyan",
      });

      if (operatorUsdcBalance < grossCharge) {
        throw new Error(
          `Wallet USDC balance ${formatAmount(operatorUsdcBalance, usdcDecimals, 6, 6)} is below required ${formatAmount(grossCharge, usdcDecimals, 6, 6)}. The deployed WizPayAgenticPro is currently priced in units that do not match Arc USDC decimals, so sending a payroll challenge now would not be a real executable payroll.`
        );
      }

      if (allowance < grossCharge) {
        throw new Error(
          `USDC allowance ${formatAmount(allowance, usdcDecimals, 6, 6)} is below required ${formatAmount(grossCharge, usdcDecimals, 6, 6)}. One-signature mode assumes the Circle wallet has already approved ${shortenAddress(payrollRouterAddress)}.`
        );
      }

      const callData = encodeFunctionData({
        abi: WIZPAY_AGENTIC_PRO_ABI,
        functionName: "batchPayAgents",
        args: [agents, taskHashes, desiredTreasuryAddress as Address],
      });

      const challenge = await createContractExecutionChallenge({
        walletId: operatorWalletId,
        contractAddress: payrollRouterAddress,
        callData,
        feeLevel: "MEDIUM",
        memo: "WizPay global agentic payroll (50 tasks)",
        refId: `wizagent-payroll-${runSalt}`,
      });

      appendLog({
        tag: "CIRCLE",
        message: `Challenge ${challenge.challengeId.slice(0, 12)}... created. Awaiting Circle approval modal.`,
        tone: "muted",
      });

      const challengeResult = await executeChallenge(challenge.challengeId);
      const txHash = await resolveChallengeTxHash({
        challengeId: challenge.challengeId,
        initialResult: challengeResult,
        logContext: "Payroll batch",
        transactionId: challenge.transactionId,
      });

      activeExecutionRef.current.txHash = txHash;
      setLastTxHash(txHash);
      appendLog({
        tag: "SIGN",
        message: `Circle approval complete. Provider transaction hash confirmed: ${txHash}.`,
        tone: "cyan",
        href: `${ARCSCAN_BASE_URL}/tx/${txHash}`,
        hrefLabel: "Open ArcScan TX",
      });
      appendLog({
        tag: "CHAIN",
        message: "Watching WizPayAgenticPro.AgentPaid events from Arc in real time.",
        tone: "muted",
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status !== "success") {
        throw new Error(`Arc transaction ${txHash} was mined but marked as reverted.`);
      }

      const touchedAddresses = Array.from(
        new Set(receipt.logs.map((log) => log.address.toLowerCase()))
      );

      const agentPaidEvents = parseEventLogs({
        abi: WIZPAY_AGENTIC_PRO_ABI,
        eventName: "AgentPaid",
        logs: receipt.logs,
        strict: false,
      });

      const batchEvents = parseEventLogs({
        abi: WIZPAY_AGENTIC_PRO_ABI,
        eventName: "BatchPaymentExecuted",
        logs: receipt.logs,
        strict: false,
      });

      for (const eventLog of agentPaidEvents) {
        const { args } = eventLog;
        if (
          !args.taskHash ||
          !args.agent ||
          !args.settlementToken ||
          typeof args.settlementAmount !== "bigint" ||
          typeof args.treasuryFee !== "bigint"
        ) {
          continue;
        }

        recordAgentPaidEvent({
          agent: args.agent,
          logIndex: eventLog.logIndex,
          settlementAmount: args.settlementAmount,
          settlementToken: args.settlementToken,
          taskHash: args.taskHash,
          transactionHash: receipt.transactionHash,
          treasuryFee: args.treasuryFee,
        });
      }

      if (agentPaidEvents.length === 0) {
        throw new Error(
          `Arc transaction ${txHash} confirmed, but WizPayAgenticPro emitted no AgentPaid events. Receipt touched ${touchedAddresses.length > 0 ? touchedAddresses.join(", ") : "no contract logs"}.`
        );
      }

      if (agentPaidEvents.length !== agents.length) {
        throw new Error(
          `Arc transaction ${txHash} confirmed with ${agentPaidEvents.length}/${agents.length} AgentPaid events. Terminal output would be incomplete.`
        );
      }

      const batchSummary = batchEvents[0]?.args;

      appendLog({
        tag: "ARC",
        message: `Arc Testnet TX confirmed at block ${receipt.blockNumber.toString()}.`,
        tone: "cyan",
        href: `${ARCSCAN_BASE_URL}/tx/${txHash}`,
        hrefLabel: "Open ArcScan TX",
      });
      appendLog({
        tag: "GAS",
        message: "Gas Fee: $0.00 (ERC-4337 Sponsored)",
        tone: "cyan",
      });
      appendLog({
        tag: "DONE",
        message:
          batchSummary &&
          typeof batchSummary.agentCount === "bigint" &&
          typeof batchSummary.totalUsdcCharged === "bigint" &&
          typeof batchSummary.swapCount === "bigint" &&
          typeof batchSummary.treasuryFeeTotal === "bigint"
            ? `Global Agentic Payroll complete on-chain with ${batchSummary.agentCount.toString()} AgentPaid events, ${formatAmount(batchSummary.totalUsdcCharged, usdcDecimals, 6, 6)} USDC charged, and ${batchSummary.swapCount.toString()} FX swap leg(s).`
            : `Global Agentic Payroll complete on-chain with ${agentPaidEvents.length.toString()} AgentPaid events.`,
        tone: "matrix",
      });

      setRunCount((current) => current + 1);
      await refreshTreasuryBalance();
      activeExecutionRef.current = null;
    } catch (nextError) {
      activeExecutionRef.current = null;
      appendLog({
        tag: "ERROR",
        message: normalizeError(nextError),
        tone: "amber",
      });
    } finally {
      if (executionRef.current === currentExecution) {
        setIsRunning(false);
      }
    }
  }

  return (
    <main className="terminal-page">
      <section className="hero-panel">
        <div>
          <h1>Payroll</h1>
          <p className="hero-copy">Use the controls on the right, then run payroll.</p>
        </div>

        <div className="hero-status-row">
          <span className="system-chip is-live">{chainName}</span>
          <span className="system-chip">Chain ID {chainId}</span>
          <span className="system-chip">Circle SDK {ready ? "Ready" : "Booting"}</span>
          <span className="system-chip is-cold">Gas Fee: $0.00 (ERC-4337 Sponsored)</span>
        </div>
      </section>

      <section className="terminal-grid">
        <div className="terminal-main-column">
          <div className="division-grid">
            {divisions.map((division) => (
              <article className="division-card" key={division.id}>
                <p className="division-id">{division.id}</p>
                <h2>{division.name}</h2>
                <p>{division.description}</p>
                <span className="division-status">{division.status}</span>
              </article>
            ))}
          </div>

          <section className="window-card">
            <div className="window-bar">
              <div className="window-controls" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p>agentic-payroll://live-stream</p>
              <span className="window-badge">REAL-TIME LOGS</span>
            </div>

            <div className="telemetry-grid">
              <article className="telemetry-card">
                <span>Payroll Router</span>
                <strong>{shortenAddress(contractAddress)}</strong>
                <code>{contractAddress}</code>
              </article>
              <article className="telemetry-card">
                <span>StableFXAdapter</span>
                <strong>{shortenAddress(stableFxAdapterAddress)}</strong>
                <code>{stableFxAdapterAddress}</code>
              </article>
              <article className="telemetry-card">
                <span>Primary RPC</span>
                <strong>{shortenAddress(rpcUrl)}</strong>
                <code>{rpcUrl}</code>
              </article>
            </div>

            <div className="terminal-window" ref={viewportRef}>
              {deferredLogs.map((entry) => (
                <div className={`terminal-line tone-${entry.tone}`} key={entry.id}>
                  <span className="terminal-tag">[{entry.tag}]</span>
                  <span className="terminal-message">
                    {entry.message}
                    {entry.href ? (
                      <>
                        {" "}
                        <a
                          className="terminal-link"
                          href={entry.href}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {entry.hrefLabel ?? "Open"}
                        </a>
                      </>
                    ) : null}
                  </span>
                </div>
              ))}

              <div className="terminal-line tone-muted">
                <span className="terminal-tag">[STATUS]</span>
                <span className="terminal-message">
                  {isRunning ? (
                    <>
                      payroll and Circle execution live{" "}
                      <span className="terminal-cursor" aria-hidden="true" />
                    </>
                  ) : (
                    status ?? "system idle"
                  )}
                </span>
              </div>
            </div>

            <div className="action-row">
              <div className="action-stack">
                <button
                  className="execute-button"
                  disabled={isRunning || !ready || !payrollRouterAddress}
                  onClick={() => {
                    void handleExecute();
                  }}
                  type="button"
                >
                  Execute Global Agentic Payroll (50 Tasks)
                </button>
                <p className="action-hint">
                  Use the sidebar buttons: store session, sync wallet, approve USDC, then click execute.
                </p>
              </div>

              <div className="run-metrics" aria-live="polite">
                <span>Runs: {String(runCount).padStart(2, "0")}</span>
                <span>Agents per sweep: 50</span>
                <span>
                  Preview: {lastGrossCharge !== null ? `${formatAmount(lastGrossCharge, usdcDecimals, 2, 2)} USDC` : "pending"}
                </span>
                <span>{isRunning ? "State: Watching Chain" : "State: Armed"}</span>
              </div>
            </div>
          </section>
        </div>

        <aside className="terminal-sidebar">
          <section className="ops-card">
            <p className="intel-label">Circle Access</p>
            <p className="ops-copy">
              Fill in the Circle fields here, then run every step with the buttons. No terminal commands are required.
            </p>
            <ol className="ops-steps">
              <li>
                Open <a className="terminal-link" href="https://app.wizpay.xyz" rel="noreferrer" target="_blank">app.wizpay.xyz</a>.
              </li>
              <li>Sign in with Google only.</li>
              <li>Complete the email OTP verification until login succeeds.</li>
              <li>Do not use other login methods because Circle session retrieval will fail.</li>
              <li>After login, copy userToken and encryptionKey, then paste them into this form.</li>
            </ol>

            <div className="ops-field-grid">
              <label
                className={`terminal-field terminal-field--full ${
                  isInjectionGlowActive ? "is-injected" : ""
                }`}
              >
                <span>User Token</span>
                <textarea
                  onChange={(event) => setUserTokenInput(event.target.value.trim())}
                  placeholder="Paste userToken from app.wizpay.xyz"
                  rows={3}
                  value={userTokenInput}
                />
              </label>
              <label
                className={`terminal-field terminal-field--full ${
                  isInjectionGlowActive ? "is-injected" : ""
                }`}
              >
                <span>Encryption Key</span>
                <textarea
                  onChange={(event) => setEncryptionKeyInput(event.target.value.trim())}
                  placeholder="Paste encryptionKey from app.wizpay.xyz"
                  rows={3}
                  value={encryptionKeyInput}
                />
              </label>
              <label
                className={`terminal-field terminal-field--full ${
                  isInjectionGlowActive ? "is-injected" : ""
                }`}
              >
                <span>Wallet ID</span>
                <input
                  onChange={(event) => setWalletIdInput(event.target.value.trim())}
                  placeholder="Optional: paste Circle ARC wallet ID"
                  value={walletIdInput}
                />
              </label>
              <label
                className={`terminal-field terminal-field--full ${
                  isInjectionGlowActive ? "is-injected" : ""
                }`}
              >
                <span>Treasury Route</span>
                <input
                  disabled={!CUSTOM_TREASURY_ROUTE_ENABLED}
                  onChange={(event) => setTreasuryAddress(event.target.value.trim())}
                  placeholder={
                    CUSTOM_TREASURY_ROUTE_ENABLED
                      ? "Optional: paste treasury override address"
                      : "Contract treasury route is locked for this deployment"
                  }
                  value={CUSTOM_TREASURY_ROUTE_ENABLED ? treasuryAddress : displayedTreasuryAddress}
                />
              </label>
            </div>

            <div className="ops-actions">
              <button
                className="security-step-button"
                disabled={isApprovingAllowance}
                onClick={() => {
                  void handleApprovePayrollAllowance();
                }}
                type="button"
              >
                {isApprovingAllowance
                  ? "[Enabling Payroll...]"
                  : "[Enable Payroll (Approve USDC)]"}
              </button>
              <button
                className="smart-paste-button"
                disabled={isSmartPasting}
                onClick={() => {
                  void handleSmartPaste();
                }}
                type="button"
              >
                {isSmartPasting ? "Injecting Payload..." : "Smart Paste from WizPay"}
              </button>
              <button onClick={handleSaveSession} type="button">
                Store Session
              </button>
              <button
                className="subtle-button"
                onClick={() => {
                  void handleSyncWallet();
                }}
                type="button"
              >
                Sync ARC Wallet
              </button>
              <button
                className="subtle-button"
                onClick={() => {
                  handleClearSession();
                }}
                type="button"
              >
                Clear Session
              </button>
            </div>

            <div className="status-strip">
              <span>SDK: {ready ? "ready" : "booting"}</span>
              <span>Wallet: {walletAddress ? shortenAddress(walletAddress) : "not linked"}</span>
              <span>
                Treasury: {displayedTreasuryAddress ? shortenAddress(displayedTreasuryAddress) : "contract route unknown"}
              </span>
              <span>
                Charge: {lastGrossCharge ? `${formatAmount(lastGrossCharge, usdcDecimals, 6, 6)} USDC` : "pending"}
              </span>
              <span>
                Wallet USDC: {walletUsdcBalance !== null ? formatAmount(walletUsdcBalance, usdcDecimals, 6, 6) : "pending"}
              </span>
            </div>

            <p className={`status-copy ${error ? "is-error" : ""}`}>
              {error ?? status ?? "Circle operator console idle."}
            </p>
          </section>

          <section className="treasury-card">
            <p className="treasury-label">Treasury-Bot (LP Agent)</p>
            <h2>
              {treasuryBalance !== null
                ? `${formatAmount(treasuryBalance, usdcDecimals, 6, 6)} USDC`
                : "Loading real balance..."}
            </h2>
            <p className="treasury-copy">
              Live USDC balance for the active contract treasury route on Arc Testnet.
            </p>
            <code className="treasury-route-copy">
              {displayedTreasuryAddress || "Awaiting treasury route..."}
            </code>

            <div className="treasury-metrics">
              <div>
                <span>LP Fee</span>
                <strong>0.300%</strong>
              </div>
              <div>
                <span>Settlement Mode</span>
                <strong>USDC / EURC</strong>
              </div>
              <div>
                <span>Bundler Cost</span>
                <strong>$0.00</strong>
              </div>
              <div>
                <span>Session Fee Lift</span>
                <strong>+{formatAmount(sessionFeeLift, usdcDecimals, 6, 6)} USDC</strong>
              </div>
            </div>
          </section>

          <section className="intel-card">
            <p className="intel-label">Ops Snapshot</p>
            <ul>
              <li>Three AI divisions online.</li>
              <li>One Circle signature dispatches the full 50-task payroll call.</li>
              <li>Agentic logs are emitted only from on-chain AgentPaid events.</li>
              <li>Gas Fee: $0.00 (ERC-4337 Sponsored).</li>
              <li>Contract anchor: {shortenAddress(contractAddress)}</li>
              <li>Wallet anchor: {walletAddress ? shortenAddress(walletAddress) : "waiting for Circle wallet"}</li>
            </ul>

            {explorerLink ? (
              <a className="terminal-link last-hash-link" href={explorerLink} rel="noreferrer" target="_blank">
                Last Arc TX: {shortenAddress(lastTxHash ?? "")}
              </a>
            ) : null}
          </section>
        </aside>
      </section>
    </main>
  );
}