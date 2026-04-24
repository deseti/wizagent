const TASK_SEQUENCE = ["analyze", "validate", "execute"] as const;
const ROLE_BY_TASK = {
  analyze: "analyst",
  validate: "validator",
  execute: "executor",
} as const;
const DEFAULT_TASK_COUNT = 50;
const MAX_TASK_COUNT = 50;
const MAX_MICRO_PAYMENT = 0.0099;
const DEFAULT_GOAL = "process_tasks_and_pay_agents";
const HIGH_PRIORITY_KEYWORDS = [
  "urgent",
  "critical",
  "asap",
  "immediately",
  "pay",
  "payroll",
  "payment",
  "settle",
  "on-chain",
  "onchain",
] as const;
const MEDIUM_PRIORITY_KEYWORDS = [
  "validate",
  "review",
  "check",
  "process",
  "batch",
  "plan",
] as const;
const GOAL_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "the",
  "to",
  "with",
  "of",
  "my",
  "our",
  "please",
]);
const TASK_WEIGHTS = {
  analyze: 0.64,
  validate: 0.48,
  execute: 0.78,
} as const;

export type TaskType = (typeof TASK_SEQUENCE)[number];
export type AgentRole = (typeof ROLE_BY_TASK)[TaskType];
export type Priority = "low" | "medium" | "high";

export type Plan = {
  goal: string;
  mode: "autonomous";
  task_count: number;
  max_cost_per_task: number;
  priority: Priority;
};

export type Task = {
  id: string;
  type: TaskType;
  reward: number;
};

export type Agent = {
  id: string;
  role: AgentRole;
  wallet: string;
  cost: number;
};

export type Assignment = {
  task_id: string;
  agent_id: string;
  wallet: string;
  reward: number;
};

type ValidationResult = {
  approved: boolean;
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && TASK_SEQUENCE.includes(value as TaskType);
}

function isAgentRole(value: unknown): value is AgentRole {
  return (
    value === "analyst" || value === "validator" || value === "executor"
  );
}

function isWallet(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function roundMoney(value: number) {
  return Number(value.toFixed(4));
}

function toFiniteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function clampTaskCount(value: unknown) {
  const numericValue = toFiniteNumber(value);
  if (numericValue === null) {
    return DEFAULT_TASK_COUNT;
  }

  return Math.min(MAX_TASK_COUNT, Math.max(1, Math.trunc(numericValue)));
}

function clampMaxCost(value: unknown, fallback: number) {
  const numericValue = toFiniteNumber(value);
  const nextValue = numericValue === null ? fallback : numericValue;
  const boundedValue = Math.min(MAX_MICRO_PAYMENT, Math.max(0.0002, nextValue));
  return roundMoney(boundedValue);
}

function extractTaskCountFromIntent(userIntent: string) {
  const matchedCount = userIntent.match(/\b([1-9]\d{0,2})\b/u);
  if (!matchedCount) {
    return DEFAULT_TASK_COUNT;
  }

  return clampTaskCount(matchedCount[1]);
}

function inferPriority(userIntent: string): Priority {
  const normalizedIntent = userIntent.toLowerCase();

  if (
    HIGH_PRIORITY_KEYWORDS.some((keyword) => normalizedIntent.includes(keyword))
  ) {
    return "high";
  }

  if (
    MEDIUM_PRIORITY_KEYWORDS.some((keyword) => normalizedIntent.includes(keyword))
  ) {
    return "medium";
  }

  return "low";
}

function buildGoal(userIntent: string) {
  const tokens = (userIntent.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter(
    (token) => !GOAL_STOP_WORDS.has(token)
  );

  if (tokens.length === 0) {
    return DEFAULT_GOAL;
  }

  const compactGoal = tokens.slice(0, 6).join("_");
  return compactGoal.startsWith("process_")
    ? compactGoal
    : `process_${compactGoal}`;
}

function inferMaxCost(priority: Priority) {
  if (priority === "high") {
    return 0.009;
  }

  if (priority === "medium") {
    return 0.006;
  }

  return 0.003;
}

function taskTypeFromOrdinal(ordinal: number): TaskType {
  return TASK_SEQUENCE[(ordinal - 1) % TASK_SEQUENCE.length] ?? "analyze";
}

function parseTaskOrdinal(taskId: string) {
  const match = taskId.match(/(\d+)(?!.*\d)/u);
  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

function normalizeTask(value: unknown, index: number): Task {
  if (!isRecord(value)) {
    throw new Error("Each task must be a JSON object.");
  }

  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : `task-${index + 1}`;
  const rewardValue = toFiniteNumber(value.reward);

  if (!isTaskType(value.type)) {
    throw new Error(`Task ${id} has an invalid type.`);
  }
  if (rewardValue === null || rewardValue <= 0) {
    throw new Error(`Task ${id} must include a positive numeric reward.`);
  }

  return {
    id,
    type: value.type,
    reward: roundMoney(rewardValue),
  };
}

function normalizeAgent(value: unknown, index: number): Agent {
  if (!isRecord(value)) {
    throw new Error("Each agent must be a JSON object.");
  }

  const idSource = value.id ?? value.agent_id;
  const walletSource = value.wallet ?? value.address;
  const costValue = toFiniteNumber(value.cost);

  if (typeof idSource !== "string" || !idSource.trim()) {
    throw new Error(`Agent ${index + 1} is missing an id.`);
  }

  if (!isAgentRole(value.role)) {
    throw new Error(`Agent ${idSource} has an invalid role.`);
  }

  if (!isWallet(walletSource)) {
    throw new Error(`Agent ${idSource} has an invalid wallet.`);
  }

  if (costValue === null || costValue <= 0) {
    throw new Error(`Agent ${idSource} must include a positive numeric cost.`);
  }

  return {
    id: idSource.trim(),
    role: value.role,
    wallet: walletSource,
    cost: roundMoney(costValue),
  };
}

function normalizeAssignment(value: unknown): Assignment & { task_type?: TaskType } {
  if (!isRecord(value)) {
    throw new Error("Assignment must be a JSON object.");
  }

  const taskIdSource = value.task_id ?? value.taskId;
  const agentIdSource = value.agent_id ?? value.agentId;
  const walletSource = value.wallet;
  const rewardValue = toFiniteNumber(value.reward);

  if (typeof taskIdSource !== "string" || !taskIdSource.trim()) {
    throw new Error("Assignment is missing task_id.");
  }
  if (typeof agentIdSource !== "string" || !agentIdSource.trim()) {
    throw new Error("Assignment is missing agent_id.");
  }
  if (!isWallet(walletSource)) {
    throw new Error("Assignment wallet must be a valid EVM address.");
  }
  if (rewardValue === null || rewardValue <= 0) {
    throw new Error("Assignment reward must be a positive number.");
  }

  const taskTypeValue =
    isTaskType(value.task_type) ? value.task_type : isTaskType(value.type) ? value.type : undefined;

  return {
    task_id: taskIdSource.trim(),
    agent_id: agentIdSource.trim(),
    wallet: walletSource,
    reward: roundMoney(rewardValue),
    ...(taskTypeValue ? { task_type: taskTypeValue } : {}),
  };
}

export function createPlan(input: {
  max_cost_per_task?: unknown;
  task_count?: unknown;
  user_intent?: unknown;
}): Plan {
  const userIntent =
    typeof input.user_intent === "string" ? input.user_intent.trim() : "";
  const priority = inferPriority(userIntent);
  const taskCount =
    typeof input.task_count === "undefined"
      ? extractTaskCountFromIntent(userIntent)
      : clampTaskCount(input.task_count);
  const maxCostPerTask = clampMaxCost(
    input.max_cost_per_task,
    inferMaxCost(priority)
  );

  return {
    goal: buildGoal(userIntent),
    mode: "autonomous",
    task_count: taskCount,
    max_cost_per_task: maxCostPerTask,
    priority,
  };
}

export function createTasks(input: {
  max_cost_per_task?: unknown;
  task_count?: unknown;
}): { tasks: Task[] } {
  const taskCount = clampTaskCount(input.task_count);
  const maxCostPerTask = clampMaxCost(input.max_cost_per_task, 0.006);
  const rewardCap = Math.max(0.0001, roundMoney(maxCostPerTask - 0.0001));

  return {
    tasks: Array.from({ length: taskCount }, (_, index) => {
      const taskNumber = index + 1;
      const type = taskTypeFromOrdinal(taskNumber);
      const cycleOffset = Math.floor(index / TASK_SEQUENCE.length) % 4;
      const candidateReward =
        maxCostPerTask * TASK_WEIGHTS[type] + cycleOffset * 0.0001;

      return {
        id: `task-${taskNumber}`,
        type,
        reward: roundMoney(
          Math.max(0.0001, Math.min(MAX_MICRO_PAYMENT, rewardCap, candidateReward))
        ),
      };
    }),
  };
}

export function createAssignments(input: {
  agents: unknown;
  tasks: unknown;
}): { assignments: Assignment[] } {
  const rawAgents = Array.isArray(input.agents) ? input.agents : null;
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : null;

  if (!rawAgents || rawAgents.length === 0) {
    throw new Error("agents must be a non-empty array.");
  }

  if (!rawTasks || rawTasks.length === 0) {
    throw new Error("tasks must be a non-empty array.");
  }

  const agents = rawAgents.map(normalizeAgent).sort((left, right) => {
    if (left.cost !== right.cost) {
      return left.cost - right.cost;
    }

    return left.id.localeCompare(right.id);
  });
  const tasks = rawTasks.map(normalizeTask);

  return {
    assignments: tasks.map((task) => {
      const matchingRole = ROLE_BY_TASK[task.type];
      const selectedAgent = agents.find((agent) => agent.role === matchingRole);

      if (!selectedAgent) {
        throw new Error(`No ${matchingRole} agent is available for ${task.id}.`);
      }

      return {
        task_id: task.id,
        agent_id: selectedAgent.id,
        wallet: selectedAgent.wallet,
        reward: task.reward,
      };
    }),
  };
}

export function validateAssignment(input: {
  assignment: unknown;
  task_type?: unknown;
}): ValidationResult {
  const assignment = normalizeAssignment(input.assignment);
  const explicitTaskType = isTaskType(input.task_type) ? input.task_type : null;
  const inferredOrdinal = parseTaskOrdinal(assignment.task_id);
  const inferredTaskType =
    assignment.task_type ??
    explicitTaskType ??
    (inferredOrdinal ? taskTypeFromOrdinal(inferredOrdinal) : null);

  if (assignment.reward > 0.01) {
    return {
      approved: false,
      reason: "Rejected: reward exceeds the micro-payment limit.",
    };
  }

  if (!inferredTaskType || !isTaskType(inferredTaskType)) {
    return {
      approved: false,
      reason: "Rejected: task type is invalid or missing.",
    };
  }

  return {
    approved: true,
    reason: "Valid micro-payment and task verified",
  };
}
