import Fastify from "fastify";
import { loadEnvFile } from "./config/env";
import { orchestratorRoutes } from "./routes/orchestrator.routes";

loadEnvFile();

const fastify = Fastify({
  logger: {
    level: "info"
  }
});

// Register routes
fastify.register(orchestratorRoutes);

const PORT = Number(process.env.PORT || "3000");
const HOST = process.env.HOST || "0.0.0.0";

if (Number.isNaN(PORT)) {
  throw new Error("PORT must be a valid number");
}

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

const closeGracefully = async (signal: string) => {
  fastify.log.info(`Received ${signal}. Shutting down gracefully...`);
  try {
    await fastify.close();
    fastify.log.info("Server closed successfully.");
    process.exit(0);
  } catch (err) {
    fastify.log.error(err, "Error closing server");
    process.exit(1);
  }
};

process.on("SIGTERM", () => closeGracefully("SIGTERM"));
process.on("SIGINT", () => closeGracefully("SIGINT"));

start();
