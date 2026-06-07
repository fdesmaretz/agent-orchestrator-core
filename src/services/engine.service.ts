import OpenAI from "openai";
import { ExecuteWorkflowInput, AgentConfig, WorkflowPlanSchema, WorkflowPlan } from "../contracts/workflow.dto";
import { isBaseUrlAllowed } from "../config/runtime-config";

export interface StreamChunk {
  event: "status" | "token";
  data: {
    selectedAgent?: string;
    summary?: string;
    text?: string;
    step?: number;
    agent?: string;
    status?: "running" | "completed" | "streaming";
    instruction?: string;
    output?: string;
  };
}

export class EngineService {
  /**
   * Main entry point to run the stateless multi-LLM agent orchestrator workflow.
   */
  public async run(input: ExecuteWorkflowInput): Promise<string> {
    const { selectedAgent, agentClient, injectedAgentPrompt } =
      await this.prepareAgentExecution(input);

    // Call the selected agent LLM with the user's inputText and return the response
    const agentResponse = await agentClient.chat.completions.create({
      model: selectedAgent.model,
      temperature: selectedAgent.temperature,
      messages: [
        { role: "system", content: injectedAgentPrompt },
        { role: "user", content: input.inputText }
      ]
    });

    const firstResult = agentResponse.choices[0]?.message?.content;
    if (firstResult === null || firstResult === undefined) {
      throw new Error(`Agent '${selectedAgent.name}' returned an empty or invalid response`);
    }

    if (selectedAgent.isCoordinator) {
      const plan = this.parseWorkflowPlan(firstResult);
      if (plan) {
        return this.executeWorkflowPlan(input, plan);
      }
    }

    return firstResult;
  }

  /**
   * Run the workflow and stream response chunks back via SSE (Server-Sent Events) formatted payloads.
   */
  public async *runStream(
    input: ExecuteWorkflowInput
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const { selectedAgent, agentClient, injectedAgentPrompt, routingDecision } =
      await this.prepareAgentExecution(input);

    // Yield initial status detailing which agent was selected
    yield {
      event: "status",
      data: {
        selectedAgent: selectedAgent.name,
        summary: routingDecision.summary
      }
    };

    if (selectedAgent.isCoordinator) {
      // Fetch the plan synchronously from the coordinator to parse it
      const agentResponse = await agentClient.chat.completions.create({
        model: selectedAgent.model,
        temperature: selectedAgent.temperature,
        messages: [
          { role: "system", content: injectedAgentPrompt },
          { role: "user", content: input.inputText }
        ]
      });

      const firstResult = agentResponse.choices[0]?.message?.content;
      if (firstResult === null || firstResult === undefined) {
        throw new Error(`Agent '${selectedAgent.name}' returned an empty or invalid response`);
      }

      const plan = this.parseWorkflowPlan(firstResult);
      if (!plan) {
        // Fallback: if coordinator returned invalid plan, yield it as token
        yield {
          event: "token",
          data: { text: firstResult }
        };
        return;
      }

      // Execute steps in the plan
      let currentContext = { ...input.context };
      let lastOutput = input.inputText;

      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        const stepAgent = input.agentsConfig.find(
          a => a.name.trim().toLowerCase() === step.agent.trim().toLowerCase()
        );
        if (!stepAgent) {
          throw new Error(`Agent '${step.agent}' in step ${i + 1} not found in agentsConfig`);
        }

        const isLastStep = i === plan.steps.length - 1;

        // Yield start status for this step
        yield {
          event: "status",
          data: {
            step: i + 1,
            agent: stepAgent.name,
            status: isLastStep ? "streaming" : "running",
            instruction: step.instruction
          }
        };

        const stepContext = {
          ...currentContext,
          inputText: input.inputText,
          router_summary: step.instruction,
          parent_output: lastOutput
        };

        const stepInjectedPrompt = this.injectVariables(stepAgent.systemPrompt, stepContext);
        const stepAgentClient = this.initializeAgentClient(stepAgent, "agent");

        if (isLastStep) {
          // Stream the final agent's response in real-time
          const stream = await stepAgentClient.chat.completions.create({
            model: stepAgent.model,
            temperature: stepAgent.temperature,
            messages: [
              { role: "system", content: stepInjectedPrompt },
              { role: "user", content: lastOutput }
            ],
            stream: true
          });

          for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta?.content || "";
            if (text) {
              yield {
                event: "token",
                data: { text }
              };
            }
          }
        } else {
          // Synchronous execution for intermediate steps
          const stepResponse = await stepAgentClient.chat.completions.create({
            model: stepAgent.model,
            temperature: stepAgent.temperature,
            messages: [
              { role: "system", content: stepInjectedPrompt },
              { role: "user", content: lastOutput }
            ]
          });

          const stepOutput = stepResponse.choices[0]?.message?.content;
          if (stepOutput === null || stepOutput === undefined) {
            throw new Error(`Agent '${stepAgent.name}' returned empty response at step ${i + 1}`);
          }

          lastOutput = stepOutput;
          currentContext[`step_${i + 1}_output`] = lastOutput;

          // Yield intermediate step completion status
          yield {
            event: "status",
            data: {
              step: i + 1,
              agent: stepAgent.name,
              status: "completed",
              output: lastOutput
            }
          };
        }
      }
    } else {
      // Normal non-coordinator agent: stream the response immediately in real-time
      const stream = await agentClient.chat.completions.create({
        model: selectedAgent.model,
        temperature: selectedAgent.temperature,
        messages: [
          { role: "system", content: injectedAgentPrompt },
          { role: "user", content: input.inputText }
        ],
        stream: true
      });

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          yield {
            event: "token",
            data: { text }
          };
        }
      }
    }
  }

  /**
   * Executes the steps in a workflow plan sequentially.
   */
  private async executeWorkflowPlan(
    input: ExecuteWorkflowInput,
    plan: WorkflowPlan
  ): Promise<string> {
    let currentContext = { ...input.context };
    let lastOutput = input.inputText;

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const stepAgent = input.agentsConfig.find(
        a => a.name.trim().toLowerCase() === step.agent.trim().toLowerCase()
      );
      if (!stepAgent) {
        throw new Error(`Agent '${step.agent}' in step ${i + 1} not found in agentsConfig`);
      }

      const stepContext = {
        ...currentContext,
        inputText: input.inputText,
        router_summary: step.instruction,
        parent_output: lastOutput
      };

      const stepInjectedPrompt = this.injectVariables(stepAgent.systemPrompt, stepContext);
      const stepAgentClient = this.initializeAgentClient(stepAgent, "agent");

      const stepResponse = await stepAgentClient.chat.completions.create({
        model: stepAgent.model,
        temperature: stepAgent.temperature,
        messages: [
          { role: "system", content: stepInjectedPrompt },
          { role: "user", content: lastOutput }
        ]
      });

      const stepOutput = stepResponse.choices[0]?.message?.content;
      if (stepOutput === null || stepOutput === undefined) {
        throw new Error(`Agent '${stepAgent.name}' returned empty response at step ${i + 1}`);
      }

      lastOutput = stepOutput;
      currentContext[`step_${i + 1}_output`] = lastOutput;
    }

    return lastOutput;
  }

  /**
   * Tries to parse the output of a coordinator agent as a JSON workflow plan.
   */
  private parseWorkflowPlan(content: string): WorkflowPlan | null {
    try {
      const jsonContent = this.extractJsonObject(content);
      const parsed = JSON.parse(jsonContent);
      const result = WorkflowPlanSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Executes the common dry orchestrator preparation steps (routing, variables injection, client config).
   */
  private async prepareAgentExecution(input: ExecuteWorkflowInput): Promise<{
    selectedAgent: AgentConfig;
    agentClient: OpenAI;
    injectedAgentPrompt: string;
    routingDecision: { targetAgent: string; summary: string };
  }> {
    // A. Extract all available agent names
    const agentNames = input.agentsConfig.map(agent => agent.name);
    if (agentNames.length === 0) {
      throw new Error("No agents provided in agentsConfig");
    }

    // B. Inject variables into input.routerConfig.systemPrompt from context
    const injectedRouterPrompt = this.injectVariables(
      input.routerConfig.systemPrompt,
      input.context
    );

    // C. Instantiate the LLM client for the router
    const routerClient = this.initializeAgentClient(input.routerConfig, "router");

    // D. Call the LLM for the ROUTER and parse its decision
    const routingDecision = await this.createRoutingDecision(
      routerClient,
      input.routerConfig,
      injectedRouterPrompt,
      input.inputText,
      agentNames
    );

    // E. Find the matching agent
    const selectedAgent = input.agentsConfig.find(
      agent => agent.name === routingDecision.targetAgent
    );
    if (!selectedAgent) {
      throw new Error(
        `Selected agent '${routingDecision.targetAgent}' was not found in the agentsConfig list`
      );
    }

    // F. Inject variables into the selected agent's systemPrompt using context AND {{router_summary}}
    const agentContext = {
      ...input.context,
      router_summary: routingDecision.summary
    };
    const injectedAgentPrompt = this.injectVariables(
      selectedAgent.systemPrompt,
      agentContext
    );

    // G. Initialize dynamic LLM client for the agent
    const agentClient = this.initializeAgentClient(selectedAgent, "agent");

    return {
      selectedAgent,
      agentClient,
      injectedAgentPrompt,
      routingDecision
    };
  }

  /**
   * Replaces templates of the form {{variable}} with their value from the provided variables context.
   */
  private injectVariables(template: string, variables: Record<string, any>): string {
    return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, key) => {
      const trimmedKey = key.trim();
      return trimmedKey in variables ? String(variables[trimmedKey]) : match;
    });
  }

  /**
   * Creates the router decision with a structured-output call first and a JSON-only fallback second.
   */
  private async createRoutingDecision(
    client: OpenAI,
    router: AgentConfig,
    systemPrompt: string,
    inputText: string,
    agentNames: string[]
  ): Promise<{ targetAgent: string; summary: string }> {
    let lastError: Error | undefined;

    // Only attempt structured output for OpenAI (official endpoint) to avoid useless latency on 400 errors from other providers.
    const useStructuredOutput = router.provider === "openai" && !router.baseUrl;

    if (useStructuredOutput) {
      try {
        const structuredResponse = await client.chat.completions.create({
          model: router.model,
          temperature: router.temperature,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: inputText }
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "routing_decision",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  targetAgent: {
                    type: "string",
                    enum: agentNames
                  },
                  summary: {
                    type: "string"
                  }
                },
                required: ["targetAgent", "summary"],
                additionalProperties: false
              }
            }
          }
        });

        const content = structuredResponse.choices[0]?.message?.content;
        if (content) {
          return this.parseRoutingDecision(content, agentNames);
        }
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error("Structured routing call failed");
      }
    }

    const fallbackSystemPrompt = [
      systemPrompt,
      "",
      "Return ONLY a JSON object with this exact shape:",
      `{"targetAgent":"one of [${agentNames.join(", ")}]","summary":"short summary"}`,
      "Do not use markdown code fences."
    ].join("\n");

    try {
      const fallbackResponse = await client.chat.completions.create({
        model: router.model,
        temperature: router.temperature,
        messages: [
          { role: "system", content: fallbackSystemPrompt },
          { role: "user", content: inputText }
        ]
      });

      const fallbackContent = fallbackResponse.choices[0]?.message?.content;
      if (!fallbackContent) {
        throw new Error("Router LLM returned an empty response");
      }

      return this.parseRoutingDecision(fallbackContent, agentNames);
    } catch (error: unknown) {
      const fallbackError = error instanceof Error
        ? error
        : new Error("Fallback routing call failed");

      if (lastError) {
        throw new Error(
          `Router decision failed. Structured call error: ${lastError.message}. Fallback error: ${fallbackError.message}`
        );
      }

      throw fallbackError;
    }
  }

  private parseRoutingDecision(
    rawContent: string,
    agentNames: string[]
  ): { targetAgent: string; summary: string } {
    const jsonContent = this.extractJsonObject(rawContent);

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(jsonContent);
    } catch (parseError: unknown) {
      const message = parseError instanceof Error ? parseError.message : "Unknown JSON parse error";
      throw new Error(`Failed to parse router output JSON: ${message}`);
    }

    if (
      typeof parsedContent !== "object" ||
      parsedContent === null ||
      typeof (parsedContent as { targetAgent?: unknown }).targetAgent !== "string" ||
      typeof (parsedContent as { summary?: unknown }).summary !== "string"
    ) {
      throw new Error("Router output must contain string fields 'targetAgent' and 'summary'");
    }

    const routingDecision = parsedContent as { targetAgent: string; summary: string };
    const target = routingDecision.targetAgent.trim().toLowerCase();
    const matchedAgentName = agentNames.find(
      name => name.trim().toLowerCase() === target
    );

    if (!matchedAgentName) {
      throw new Error(
        `Router selected unknown agent '${routingDecision.targetAgent}'. Allowed agents: ${agentNames.join(", ")}`
      );
    }

    routingDecision.targetAgent = matchedAgentName;

    return routingDecision;
  }

  private extractJsonObject(rawContent: string): string {
    const fencedContentMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = (fencedContentMatch?.[1] || rawContent).trim();
    const startIndex = candidate.indexOf("{");
    const endIndex = candidate.lastIndexOf("}");

    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
      throw new Error("Router output did not contain a JSON object");
    }

    return candidate.slice(startIndex, endIndex + 1);
  }

  /**
   * Initializes the client based on the provider config.
   */
  private initializeAgentClient(agent: AgentConfig, role: "router" | "agent"): OpenAI {
    const resolvedBaseUrl = this.resolveBaseUrl(agent, role);

    switch (agent.provider) {
      case "openai": {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error(`Missing environment variable: OPENAI_API_KEY (required for ${role} '${agent.name}')`);
        }
        return new OpenAI({
          apiKey,
          baseURL: resolvedBaseUrl
        });
      }

      case "mistral": {
        const apiKey = process.env.MISTRAL_API_KEY;
        if (!apiKey) {
          throw new Error(`Missing environment variable: MISTRAL_API_KEY (required for ${role} '${agent.name}')`);
        }
        return new OpenAI({
          apiKey,
          baseURL: resolvedBaseUrl
        });
      }

      case "local": {
        if (!resolvedBaseUrl) {
          throw new Error(`baseUrl is required for Local provider on ${role} '${agent.name}'`);
        }
        return new OpenAI({
          apiKey: process.env.LOCAL_LLM_API_KEY || "ollama",
          baseURL: resolvedBaseUrl
        });
      }

      default: {
        throw new Error(`Unsupported provider: ${(agent as any).provider}`);
      }
    }
  }

  private resolveBaseUrl(agent: AgentConfig, role: "router" | "agent"): string | undefined {
    const baseUrl = agent.baseUrl || (agent.provider === "mistral" ? "https://api.mistral.ai/v1" : undefined);
    if (!baseUrl) {
      return undefined;
    }

    if (!isBaseUrlAllowed(baseUrl)) {
      throw new Error(
        `baseUrl '${baseUrl}' is not allowed for ${role} '${agent.name}'. Configure ALLOWED_BASE_URLS or disable allowlist enforcement.`
      );
    }

    return baseUrl;
  }
}
