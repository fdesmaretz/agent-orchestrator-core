import { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from "fastify";
import { ExecuteWorkflowSchema } from "../contracts/workflow.dto";
import { getConfiguredApiToken, isProduction } from "../config/runtime-config";
import { EngineService } from "../services/engine.service";

export async function orchestratorRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions
) {
  const engineService = new EngineService();

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const expectedToken = getConfiguredApiToken();
    if (!expectedToken) {
      return;
    }

    const authorizationHeader = request.headers.authorization;
    if (!authorizationHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Missing Bearer token"
      });
    }

    const providedToken = authorizationHeader.slice("Bearer ".length).trim();
    if (providedToken !== expectedToken) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid Bearer token"
      });
    }
  };

  // GET /health -> returns { status: "UP" }
  fastify.get("/health", async (request, reply) => {
    return { status: "UP" };
  });

  // POST /api/v1/execute -> validates and executes workflow
  fastify.post("/api/v1/execute", { preHandler: authenticate }, async (request, reply) => {
    const parseResult = ExecuteWorkflowSchema.safeParse(request.body);
    
    if (!parseResult.success) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Payload validation failed",
        details: parseResult.error.format()
      });
    }

    try {
      const result = await engineService.run(parseResult.data);
      return { outputText: result };
    } catch (error: unknown) {
      fastify.log.error(error);
      const message = error instanceof Error
        ? error.message
        : "An error occurred during workflow execution";

      return reply.status(500).send({
        error: "Internal Server Error",
        message: "Workflow execution failed",
        ...(isProduction() ? {} : { details: message })
      });
    }
  });

  // POST /api/v1/execute/stream -> executes workflow and streams responses back as SSE
  fastify.post("/api/v1/execute/stream", { preHandler: authenticate }, async (request, reply) => {
    const parseResult = ExecuteWorkflowSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Payload validation failed",
        details: parseResult.error.format()
      });
    }

    try {
      const generator = engineService.runStream(parseResult.data);

      // Verify that the initial routing step runs successfully before writing headers
      const firstResult = await generator.next();

      if (firstResult.done) {
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Workflow stream execution failed: empty stream"
        });
      }

      // If preparation succeeded, write Server-Sent Events (SSE) headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no" // Disable proxy buffering for streaming responsiveness
      });

      // Write the first chunk (selected agent / routing summary status)
      const firstChunk = firstResult.value;
      reply.raw.write(`event: ${firstChunk.event}\ndata: ${JSON.stringify(firstChunk.data)}\n\n`);

      // Write subsequent token chunks
      for await (const chunk of generator) {
        reply.raw.write(`event: ${chunk.event}\ndata: ${JSON.stringify(chunk.data)}\n\n`);
      }

      reply.raw.write("event: done\ndata: [DONE]\n\n");
    } catch (error: unknown) {
      fastify.log.error(error);
      const message = error instanceof Error
        ? error.message
        : "An error occurred during workflow stream execution";

      if (!reply.raw.headersSent) {
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Workflow stream execution failed",
          ...(isProduction() ? {} : { details: message })
        });
      }

      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
}
