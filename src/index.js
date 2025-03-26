// Load environment variables first
import { config } from "dotenv";
config();

import Fastify from "fastify";
import cors from "@fastify/cors";
import "./config/firebase.js";
import { setupWebhookRoutes } from "./routes/webhookRoutes.js";
import { setupBookRoutes } from "./routes/bookRoutes.js";
import { setupCallRoutes } from "./routes/callRoutes.js";
import { startScheduledCallsCron } from "./cron/scheduledCalls.js";

const fastify = Fastify({
  logger: true,
});

// Enable CORS
await fastify.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});

// Setup routes
setupWebhookRoutes(fastify);
setupBookRoutes(fastify);
setupCallRoutes(fastify);

// Start the cron job
startScheduledCallsCron();

// Start the server
try {
  await fastify.listen({ port: 3000 });
  console.log("Server listening on port 3000");
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
