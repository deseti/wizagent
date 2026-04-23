import { NextResponse } from "next/server";

const CIRCLE_BASE_URL =
  process.env.CIRCLE_BASE_URL ??
  process.env.NEXT_PUBLIC_CIRCLE_BASE_URL ??
  "https://api.circle.com";
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY ?? "";
const MAX_RATE_LIMIT_ATTEMPTS = 2;
const BASE_RATE_LIMIT_DELAY_MS = 800;
const MAX_RATE_LIMIT_DELAY_MS = 30_000;
const FALLBACK_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const ALLOWED_ACTIONS = new Set([
  "initializeUser",
  "listWallets",
  "getWalletBalances",
  "createContractExecutionChallenge",
  "getChallengeTransactionStatus",
]);

type CircleActionBody = {
  action?: string;
  [key: string]: unknown;
};

type CircleApiResult = {
  ok: boolean;
  payload: unknown;
  retryAfterMs: number | null;
  status: number;
};

type ContractExecutionPayload = {
  walletId: string;
  contractAddress: string;
  callData: string;
  feeLevel?: "LOW" | "MEDIUM" | "HIGH";
  memo?: string;
  refId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isHexData(value: unknown): value is string {
  return typeof value === "string" && /^0x(?:[a-fA-F0-9]{2})*$/.test(value);
}

function normalizeOrigin(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

function getExpectedOrigin(request: Request) {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? null;

  if (!host) {
    return null;
  }

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const proto =
    forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");

  return `${proto}://${host}`.toLowerCase();
}

function getAllowedOrigins(request: Request) {
  const origins = new Set<string>();
  const expectedOrigin = getExpectedOrigin(request);

  if (expectedOrigin) {
    origins.add(expectedOrigin);
  }

  for (const value of [
    process.env.CIRCLE_ALLOWED_ORIGINS,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.APP_URL,
  ]) {
    if (!value) {
      continue;
    }

    for (const candidate of value.split(",")) {
      const normalizedCandidate = normalizeOrigin(candidate.trim());
      if (normalizedCandidate) {
        origins.add(normalizedCandidate);
      }
    }
  }

  return origins;
}

function isTrustedBrowserRequest(request: Request) {
  const allowedOrigins = getAllowedOrigins(request);
  if (allowedOrigins.size === 0) {
    return false;
  }

  const headerOrigin = normalizeOrigin(request.headers.get("origin"));
  if (headerOrigin && allowedOrigins.has(headerOrigin)) {
    return true;
  }

  const refererOrigin = normalizeOrigin(request.headers.get("referer"));
  return refererOrigin ? allowedOrigins.has(refererOrigin) : false;
}

function getAllowedContractAddresses() {
  const addresses = new Set<string>();

  for (const value of [
    process.env.WIZPAY_AGENTIC_PRO_ADDRESS,
    process.env.NEXT_PUBLIC_WIZPAY_AGENTIC_PRO_ADDRESS,
    process.env.WIZPAY_USDC_ADDRESS,
    process.env.NEXT_PUBLIC_WIZPAY_USDC_ADDRESS,
    FALLBACK_USDC_ADDRESS,
  ]) {
    if (isHexAddress(value)) {
      addresses.add(value.toLowerCase());
    }
  }

  return addresses;
}

function validateContractExecutionPayload(payload: unknown): ContractExecutionPayload {
  if (!isRecord(payload)) {
    throw new Error("Missing contract execution payload.");
  }

  const walletId = typeof payload.walletId === "string" ? payload.walletId.trim() : "";
  const contractAddress =
    typeof payload.contractAddress === "string" ? payload.contractAddress.trim() : "";
  const callData = typeof payload.callData === "string" ? payload.callData.trim() : "";
  const feeLevel = payload.feeLevel;
  const memo = payload.memo;
  const refId = payload.refId;

  if (!walletId) {
    throw new Error("Missing walletId in contract execution payload.");
  }
  if (!isHexAddress(contractAddress)) {
    throw new Error("contractAddress must be a valid EVM address.");
  }
  if (!isHexData(callData) || callData.length < 10) {
    throw new Error("callData must be valid hex calldata.");
  }
  if (
    typeof feeLevel !== "undefined" &&
    feeLevel !== "LOW" &&
    feeLevel !== "MEDIUM" &&
    feeLevel !== "HIGH"
  ) {
    throw new Error("feeLevel must be LOW, MEDIUM, or HIGH.");
  }
  if (typeof memo !== "undefined" && (typeof memo !== "string" || memo.length > 160)) {
    throw new Error("memo must be a string up to 160 characters.");
  }
  if (typeof refId !== "undefined" && (typeof refId !== "string" || refId.length > 160)) {
    throw new Error("refId must be a string up to 160 characters.");
  }

  const allowedContractAddresses = getAllowedContractAddresses();
  if (!allowedContractAddresses.has(contractAddress.toLowerCase())) {
    throw new Error("contractAddress is not allowed by this deployment.");
  }

  return {
    walletId,
    contractAddress,
    callData,
    ...(feeLevel ? { feeLevel } : {}),
    ...(typeof memo === "string" ? { memo } : {}),
    ...(typeof refId === "string" ? { refId } : {}),
  };
}

function getNestedValue(source: unknown, path: Array<string | number>) {
  let current: unknown = source;

  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current) || typeof current[key] === "undefined") {
        return undefined;
      }

      current = current[key];
      continue;
    }

    if (!isRecord(current) || typeof current[key] === "undefined") {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function getNestedString(source: unknown, path: Array<string | number>) {
  const value = getNestedValue(source, path);
  return typeof value === "string" && value ? value : null;
}

function getStringFromArrayCollection(
  source: unknown,
  collectionPaths: Array<Array<string | number>>,
  itemFieldPaths: Array<Array<string | number>>
) {
  for (const collectionPath of collectionPaths) {
    const collection = getNestedValue(source, collectionPath);
    if (!Array.isArray(collection)) {
      continue;
    }

    for (const item of collection) {
      for (const itemFieldPath of itemFieldPaths) {
        const value = getNestedString(item, itemFieldPath);
        if (value) {
          return value;
        }
      }
    }
  }

  return null;
}

function extractTxHash(payload: unknown) {
  return (
    getNestedString(payload, ["txHash"]) ??
    getNestedString(payload, ["transactionHash"]) ??
    getNestedString(payload, ["data", "txHash"]) ??
    getNestedString(payload, ["data", "transactionHash"]) ??
    getNestedString(payload, ["transaction", "txHash"]) ??
    getNestedString(payload, ["transaction", "transactionHash"]) ??
    getNestedString(payload, ["challenge", "txHash"]) ??
    getNestedString(payload, ["challenge", "transactionHash"]) ??
    getNestedString(payload, ["challenge", "transaction", "txHash"]) ??
    getNestedString(payload, ["challenge", "transaction", "transactionHash"]) ??
    getStringFromArrayCollection(
      payload,
      [["transactions"], ["data", "transactions"]],
      [["txHash"], ["transactionHash"]]
    )
  );
}

function extractTransactionId(payload: unknown) {
  return (
    getNestedString(payload, ["transactionId"]) ??
    getNestedString(payload, ["data", "transactionId"]) ??
    getNestedString(payload, ["transaction", "id"]) ??
    getNestedString(payload, ["transaction", "transactionId"]) ??
    getNestedString(payload, ["challenge", "transactionId"]) ??
    getNestedString(payload, ["challenge", "transaction", "id"]) ??
    getNestedString(payload, ["challenge", "transaction", "transactionId"]) ??
    getStringFromArrayCollection(
      payload,
      [["transactions"], ["data", "transactions"]],
      [["id"], ["transactionId"]]
    )
  );
}

function extractStatus(payload: unknown) {
  return (
    getNestedString(payload, ["status"]) ??
    getNestedString(payload, ["state"]) ??
    getNestedString(payload, ["data", "status"]) ??
    getNestedString(payload, ["data", "state"]) ??
    getNestedString(payload, ["transaction", "status"]) ??
    getNestedString(payload, ["transaction", "state"]) ??
    getNestedString(payload, ["challenge", "status"]) ??
    getNestedString(payload, ["challenge", "state"])
  );
}

function waitFor(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfterHeaderMs(value: string | null) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.max(timestamp - Date.now(), 0);
}

function getRetryAfterMs(payload: unknown, headerValue: string | null) {
  const headerMs = parseRetryAfterHeaderMs(headerValue);
  const record = isRecord(payload) ? payload : {};
  const bodyMs =
    (typeof record.retryAfterMs === "number" && record.retryAfterMs >= 0
      ? record.retryAfterMs
      : null) ??
    (typeof record.retry_after === "number" && record.retry_after >= 0
      ? record.retry_after * 1000
      : null) ??
    (typeof record.retryAfter === "number" && record.retryAfter >= 0
      ? record.retryAfter * 1000
      : null);

  if (headerMs !== null && bodyMs !== null) {
    return Math.max(headerMs, bodyMs);
  }

  return headerMs ?? bodyMs ?? null;
}

function getRateLimitDelayMs(retryAfterMs: number | null, attempt: number) {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, MAX_RATE_LIMIT_DELAY_MS);
  }

  return Math.min(
    BASE_RATE_LIMIT_DELAY_MS * 2 ** attempt,
    MAX_RATE_LIMIT_DELAY_MS
  );
}

function normalizeCircleErrorPayload({
  payload,
  retryAfterMs,
  status,
}: {
  payload: unknown;
  retryAfterMs: number | null;
  status: number;
}) {
  const record = isRecord(payload) ? payload : {};
  const message =
    (typeof record.error === "string" && record.error) ||
    (typeof record.message === "string" && record.message) ||
    (status === 429
      ? "Circle rate limit reached while contacting Circle Wallets. Retry in a few seconds."
      : `Circle request failed with status ${status}.`);

  return {
    ...record,
    error: message,
    retryAfterMs,
    status,
  };
}

function ensureApiKey() {
  if (!CIRCLE_API_KEY) {
    throw new Error(
      "CIRCLE_API_KEY is missing. Configure the server before using Circle Wallets."
    );
  }
}

async function circleRequestData({
  body,
  method,
  path,
  retryOnRateLimit,
  userToken,
}: {
  body?: Record<string, unknown>;
  method: "GET" | "POST";
  path: string;
  retryOnRateLimit?: boolean;
  userToken?: string;
}): Promise<CircleApiResult> {
  ensureApiKey();

  const url = new URL(path, CIRCLE_BASE_URL);
  const attempts = retryOnRateLimit || method === "GET" ? MAX_RATE_LIMIT_ATTEMPTS : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${CIRCLE_API_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(userToken ? { "X-User-Token": userToken } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = (await response.json().catch(() => ({}))) as {
      data?: Record<string, unknown>;
      [key: string]: unknown;
    };
    const retryAfterMs = getRetryAfterMs(
      payload,
      response.headers.get("retry-after")
    );

    if (response.ok) {
      return {
        ok: true,
        payload: payload.data ?? payload,
        retryAfterMs,
        status: response.status,
      };
    }

    if (response.status === 429 && attempt < attempts - 1) {
      const delayMs = getRateLimitDelayMs(retryAfterMs, attempt);
      await waitFor(delayMs);
      continue;
    }

    return {
      ok: false,
      payload: normalizeCircleErrorPayload({
        payload,
        retryAfterMs,
        status: response.status,
      }),
      retryAfterMs,
      status: response.status,
    };
  }

  return {
    ok: false,
    payload: {
      error: "Circle request ended before a response was returned.",
      status: 502,
    },
    retryAfterMs: null,
    status: 502,
  };
}

async function circleRequest(args: {
  body?: Record<string, unknown>;
  method: "GET" | "POST";
  path: string;
  retryOnRateLimit?: boolean;
  userToken?: string;
}) {
  const result = await circleRequestData(args);

  if (result.ok) {
    return NextResponse.json(result.payload, { status: result.status });
  }

  const headers = new Headers();

  if (result.retryAfterMs !== null) {
    headers.set("Retry-After", Math.ceil(result.retryAfterMs / 1000).toString());
  }

  return NextResponse.json(result.payload, {
    headers,
    status: result.status,
  });
}

async function resolveChallengeTransactionStatus({
  challengeId,
  transactionId: initialTransactionId,
  userToken,
}: {
  challengeId: string;
  transactionId?: string;
  userToken: string;
}) {
  const attemptedPaths: string[] = [];
  let fallbackError: CircleApiResult | null = null;
  let latestPayload: unknown = {};
  let status: string | null = null;
  let transactionId: string | null = initialTransactionId ?? null;
  let txHash: string | null = null;

  const fetchPaths = async (paths: string[]) => {
    for (const path of paths) {
      if (txHash) {
        break;
      }

      attemptedPaths.push(path);
      const result = await circleRequestData({
        method: "GET",
        path,
        retryOnRateLimit: true,
        userToken,
      });

      if (!result.ok) {
        if (result.status !== 404 && fallbackError === null) {
          fallbackError = result;
        }
        continue;
      }

      latestPayload = result.payload;
      status = extractStatus(result.payload) ?? status;
      transactionId = extractTransactionId(result.payload) ?? transactionId;
      txHash = extractTxHash(result.payload) ?? txHash;
    }
  };

  if (transactionId) {
    await fetchPaths([
      `/v1/w3s/transactions/${transactionId}`,
      `/v1/w3s/user/transactions/${transactionId}`,
    ]);
  }

  const challengePaths = [
    `/v1/w3s/challenges/${challengeId}`,
    `/v1/w3s/user/challenges/${challengeId}`,
    `/v1/w3s/challenges/${challengeId}/transactions`,
    `/v1/w3s/user/challenges/${challengeId}/transactions`,
  ];

  for (const path of challengePaths) {
    if (txHash) {
      break;
    }

    attemptedPaths.push(path);
    const result = await circleRequestData({
      method: "GET",
      path,
      retryOnRateLimit: true,
      userToken,
    });

    if (!result.ok) {
      if (result.status !== 404 && fallbackError === null) {
        fallbackError = result;
      }
      continue;
    }

    latestPayload = result.payload;
    status ??= extractStatus(result.payload);
    transactionId ??= extractTransactionId(result.payload);
    txHash ??= extractTxHash(result.payload);

    if (txHash && transactionId) {
      break;
    }
  }

  if (!txHash) {
    await fetchPaths(
      transactionId
        ? [
            `/v1/w3s/transactions/${transactionId}`,
            `/v1/w3s/user/transactions/${transactionId}`,
          ]
        : [
            `/v1/w3s/transactions?challengeId=${encodeURIComponent(challengeId)}`,
            `/v1/w3s/transactions?challengeIds=${encodeURIComponent(challengeId)}`,
            `/v1/w3s/user/transactions?challengeId=${encodeURIComponent(challengeId)}`,
            `/v1/w3s/user/transactions?challengeIds=${encodeURIComponent(challengeId)}`,
          ]
    );
  }

  if (!txHash && fallbackError !== null && !transactionId) {
    return NextResponse.json(fallbackError.payload, {
      status: fallbackError.status,
    });
  }

  return NextResponse.json(
    {
      attemptedPaths,
      challengeId,
      status,
      transactionId,
      txHash,
      raw: latestPayload,
    },
    { status: 200 }
  );
}

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!isTrustedBrowserRequest(request)) {
      return NextResponse.json(
        { error: "Blocked request origin for Circle proxy." },
        { status: 403 }
      );
    }

    const body = (await request.json()) as CircleActionBody;
    const { action, ...params } = body;

    if (!action) {
      return NextResponse.json(
        { error: "Missing required field: action" },
        { status: 400 }
      );
    }

    if (!ALLOWED_ACTIONS.has(action)) {
      return NextResponse.json(
        { error: `Unsupported action: ${action}` },
        { status: 400 }
      );
    }

    switch (action) {
      case "initializeUser": {
        const { userToken } = params;

        if (typeof userToken !== "string" || !userToken) {
          return NextResponse.json({ error: "Missing userToken" }, { status: 400 });
        }

        return circleRequest({
          method: "POST",
          path: "/v1/w3s/user/initialize",
          userToken,
          body: {
            idempotencyKey: crypto.randomUUID(),
            accountType: "SCA",
            blockchains: ["ARC-TESTNET"],
          },
          retryOnRateLimit: true,
        });
      }

      case "listWallets": {
        const { userToken } = params;

        if (typeof userToken !== "string" || !userToken) {
          return NextResponse.json({ error: "Missing userToken" }, { status: 400 });
        }

        return circleRequest({
          method: "GET",
          path: "/v1/w3s/wallets",
          userToken,
          retryOnRateLimit: true,
        });
      }

      case "getWalletBalances": {
        const { userToken, walletId } = params;

        if (
          typeof userToken !== "string" ||
          !userToken ||
          typeof walletId !== "string" ||
          !walletId
        ) {
          return NextResponse.json(
            { error: "Missing userToken or walletId" },
            { status: 400 }
          );
        }

        return circleRequest({
          method: "GET",
          path: `/v1/w3s/wallets/${walletId}/balances`,
          userToken,
          retryOnRateLimit: true,
        });
      }

      case "createContractExecutionChallenge": {
        const { userToken, payload } = params;

        if (
          typeof userToken !== "string" ||
          !userToken ||
          !payload ||
          typeof payload !== "object"
        ) {
          return NextResponse.json(
            { error: "Missing userToken or payload" },
            { status: 400 }
          );
        }

        const validatedPayload = validateContractExecutionPayload(payload);

        return circleRequest({
          method: "POST",
          path: "/v1/w3s/user/transactions/contractExecution",
          userToken,
          body: {
            idempotencyKey: crypto.randomUUID(),
            ...validatedPayload,
          },
          retryOnRateLimit: true,
        });
      }

      case "getChallengeTransactionStatus": {
        const { challengeId, transactionId, userToken } = params;

        if (
          typeof challengeId !== "string" ||
          !challengeId ||
          typeof userToken !== "string" ||
          !userToken
        ) {
          return NextResponse.json(
            { error: "Missing challengeId or userToken" },
            { status: 400 }
          );
        }

        return resolveChallengeTransactionStatus({
          challengeId,
          transactionId:
            typeof transactionId === "string" && transactionId
              ? transactionId
              : undefined,
          userToken,
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unexpected server error",
      },
      { status: 500 }
    );
  }
}
