import { NextResponse } from "next/server";

import { executeAgentEconomy } from "@/lib/agent-economy-execution";
import {
  createAssignments,
  createPlan,
  createTasks,
  validateAssignment,
} from "@/lib/agent-economy";

type AgentEconomyAction = "assign" | "plan" | "run" | "tasks" | "validate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function resolveAction(body: Record<string, unknown>): AgentEconomyAction {
  const action = body.action;

  if (
    action === "plan" ||
    action === "tasks" ||
    action === "assign" ||
    action === "validate" ||
    action === "run"
  ) {
    return action;
  }

  return "run";
}

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON.");
  }

  if (!isRecord(payload)) {
    return jsonError("Request body must be a JSON object.");
  }

  const userIntent = payload.user_intent ?? payload.userIntent;
  const taskCount = payload.task_count ?? payload.taskCount;
  const maxCostPerTask = payload.max_cost_per_task ?? payload.maxCostPerTask;

  if (payload.execute === true) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const pushEvent = async (event: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };

        void executeAgentEconomy({
          agents: payload.agents,
          onEvent: pushEvent,
          taskCount:
            typeof taskCount === "number" && Number.isFinite(taskCount)
              ? taskCount
              : typeof taskCount === "string" && taskCount.trim()
                ? Number(taskCount)
                : 50,
        })
          .catch(() => {
            // Stream consumers receive the structured error event emitted by executeAgentEconomy.
          })
          .finally(() => {
            controller.close();
          });
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "application/x-ndjson; charset=utf-8",
      },
    });
  }

  const action = resolveAction(payload);

  try {
    if (action === "plan") {
      return NextResponse.json(
        createPlan({
          user_intent: userIntent,
          task_count: taskCount,
          max_cost_per_task: maxCostPerTask,
        })
      );
    }

    if (action === "tasks") {
      return NextResponse.json(
        createTasks({
          task_count: taskCount,
          max_cost_per_task: maxCostPerTask,
        })
      );
    }

    if (action === "assign") {
      return NextResponse.json(
        createAssignments({
          agents: payload.agents,
          tasks: payload.tasks,
        })
      );
    }

    if (action === "validate") {
      return NextResponse.json(
        validateAssignment({
          assignment: payload.assignment,
          task_type: payload.task_type ?? payload.taskType,
        })
      );
    }

    const plan = createPlan({
      user_intent: userIntent,
      task_count: taskCount,
      max_cost_per_task: maxCostPerTask,
    });
    const tasks = createTasks({
      task_count: plan.task_count,
      max_cost_per_task: plan.max_cost_per_task,
    });
    const assignments = createAssignments({
      agents: payload.agents,
      tasks: tasks.tasks,
    });
    const validations = assignments.assignments.map((assignment) =>
      validateAssignment({ assignment })
    );

    return NextResponse.json({
      plan,
      ...tasks,
      ...assignments,
      validations,
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unexpected agent economy error."
    );
  }
}
