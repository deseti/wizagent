export const WIZPAY_AGENTIC_PRO_ABI = [
  {
    type: "event",
    name: "AgentPaid",
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "taskHash",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "address",
        name: "payer",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "agent",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "settlementToken",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "settlementAmount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "treasuryFee",
        type: "uint256",
      },
    ],
  },
  {
    type: "event",
    name: "BatchPaymentExecuted",
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "payer",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "agentCount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "totalUsdcCharged",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "swapCount",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "treasuryFeeTotal",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        internalType: "address",
        name: "",
        type: "address",
      },
    ],
  },
  {
    type: "function",
    name: "setTreasury",
    stateMutability: "nonpayable",
    inputs: [
      {
        internalType: "address",
        name: "newTreasury",
        type: "address",
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "batchPayAgents",
    stateMutability: "nonpayable",
    inputs: [
      {
        internalType: "address[]",
        name: "agents",
        type: "address[]",
      },
      {
        internalType: "bytes32[]",
        name: "taskHashes",
        type: "bytes32[]",
      },
      {
        internalType: "address",
        name: "_treasury",
        type: "address",
      },
    ],
    outputs: [
      {
        internalType: "uint256",
        name: "totalUsdcCharged",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "treasuryFeeTotal",
        type: "uint256",
      },
    ],
  },
  {
    type: "function",
    name: "previewBatchCost",
    stateMutability: "view",
    inputs: [
      {
        internalType: "address[]",
        name: "agents",
        type: "address[]",
      },
    ],
    outputs: [
      {
        internalType: "uint256",
        name: "totalUsdcCharge",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "swapCount",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "treasuryFeeTotal",
        type: "uint256",
      },
    ],
  },
] as const;