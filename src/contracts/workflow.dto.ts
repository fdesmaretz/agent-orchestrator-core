import { z } from "zod";

export const AgentConfigSchema = z.object({
  name: z.string().min(1, "Agent name is required"),
  model: z.string().min(1, "LLM model is required"),
  provider: z.enum(["openai", "mistral", "local"]),
  baseUrl: z.string().url("baseUrl must be a valid URL").optional(),
  systemPrompt: z.string().min(1, "System prompt is required"),
  temperature: z.number().min(0).max(2).default(0.35),
  isCoordinator: z.boolean().optional().default(false)
}).superRefine((config, ctx) => {
  if (config.provider === "local" && !config.baseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: `baseUrl is required for provider '${config.provider}'`
    });
  }
});

export const ExecuteWorkflowSchema = z.object({
  inputText: z.string().min(1, "inputText is required"),
  context: z.record(z.string(), z.any()),
  routerConfig: AgentConfigSchema,
  agentsConfig: z.array(AgentConfigSchema).min(1, "At least one agent configuration is required")
}).superRefine((input, ctx) => {
  const agentNames = input.agentsConfig.map(agent => agent.name);
  const uniqueAgentNames = new Set(agentNames);

  if (uniqueAgentNames.size !== agentNames.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agentsConfig"],
      message: "Agent names must be unique"
    });
  }
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type ExecuteWorkflowInput = z.infer<typeof ExecuteWorkflowSchema>;

export const WorkflowPlanSchema = z.object({
  steps: z.array(z.object({
    agent: z.string().min(1, "Agent name is required in workflow step"),
    instruction: z.string().min(1, "Instruction is required in workflow step")
  })).min(1, "At least one step is required in workflow plan")
});

export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;
