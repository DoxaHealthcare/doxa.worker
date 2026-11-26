import "dotenv/config";
process.env.TZ = "Africa/Lagos";
import express from "express";
import morgan from "morgan";
import logger from "./utils/logger.js";
import { initializeFirebaseAdmin } from "./utils/firebase/admin.js";
import { discordClient } from "../discord/index.js";
import { discordBotService } from "./services/discord-bot/index.js";
import {
  restoreUnSeenMessageJobs,
  restorePendingTransactionJobs,
  restorePendingTransactionExpiryJobs,
  scheduleDailyStatsJob,
  scheduleRetentionAndFollowUpJobs,
  scheduleConsultationStartReminderJob,
  scheduleConsultationSweepJob
} from "./utils/scheduler.js";
import { getRedisUrl } from "./utils/redis.js";
import { startRedisJobWorker } from "./utils/jobQueue.js";
import { acquireLeaderLease } from "./utils/leaderLease.js";
import { startUnseenMessageListener } from "./services/consultation/unseenMessageListener.js";
import { startConsultationFeedbackListener } from "./services/consultation/consultationFeedbackListener.js";

// Configure logging
const morganFormat = ":method :url :status :response-time ms";
const loggingMiddleware = morgan(morganFormat, {
  stream: {
    write: (message) => {
      const logObject = {
        method: message.split(" ")[0],
        url: message.split(" ")[1],
        status: message.split(" ")[2],
        responseTime: message.split(" ")[3],
      };
      logger.info(JSON.stringify(logObject));
    },
  },
});

// Error handling middleware
const errorHandler = (
  err: any,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) => {
  logger.error("Error:", err);
  res.status(500).json({ error: "Internal server error" });
};

// Health check route handler
const healthCheck = async (_req: express.Request, res: express.Response) => {
  try {
    logger.info({
      status: "healthy",
    });
    res.json({ status: "healthy" });
  } catch (error) {
    logger.error("Health check failed:");
    res.status(503).json({
      status: "unhealthy",
    });
  }
};

// Cleanup handlers
const setupCleanupHandlers = (cleanupTasks: Array<() => Promise<void>>) => {
  const cleanup = async () => {
    logger.info("Shutting down worker...");
    await Promise.allSettled(cleanupTasks.map(cleanupTask => cleanupTask()));
    process.exit(0);
  };

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
};

async function startServer() {
  try {
    const cleanupTasks: Array<() => Promise<void>> = [];
    const startTime = new Date();
    const serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const nigeriaTime = startTime.toLocaleString("en-GB", { timeZone: "Africa/Lagos" });

    logger.info(`Server starting...`);
    logger.info(`Server Timezone: ${serverTimeZone}`);
    logger.info(`Current Server Time: ${startTime.toLocaleString()}`);
    logger.info(`Current Nigeria Time: ${nigeriaTime}`);

    // Production guard: the worker's listeners/jobs act on real consultations.
    // PM2 production starts set NODE_ENV=production via ecosystem.config.cjs;
    // anything else pointing at the prod project must opt in explicitly.
    if (
      process.env.FIREBASE_PROJECT_ID === "doxa-1e19d" &&
      process.env.NODE_ENV !== "production" &&
      process.env.WORKER_ALLOW_PROD !== "true"
    ) {
      logger.error(
        "Refusing to start: FIREBASE_PROJECT_ID is production (doxa-1e19d) " +
          "but this process was not started as production " +
          "(NODE_ENV!=production and WORKER_ALLOW_PROD!=true). " +
          "Use .env.staging / pnpm dev:staging for local work."
      );
      process.exit(1);
    }

    const app = express();
    if (process.env.DISTOKEN) {
      const discordLease = getRedisUrl()
        ? await acquireLeaderLease("doxa:leader:discord")
        : async () => { };

      if (discordLease) {
        cleanupTasks.push(discordLease);
        discordClient.login(process.env.DISTOKEN).then(() => {
          const unsubscribe = discordBotService.listenToDiscordTasks();
          cleanupTasks.push(async () => unsubscribe());
        }).catch((error) => {
          logger.error("Failed to login to Discord:", error);
        });
      } else {
        logger.info("Another worker owns the Discord listener lease");
      }
    } else {
      logger.warn("DISTOKEN is not defined in environment variables. Discord bot will not start.");
    }
    // Initialize Firebase Admin SDK
    initializeFirebaseAdmin();
    logger.info("Firebase Admin SDK initialized", {
      firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
      env: process.env.ENV,
    });

    {
      const isDev = process.env.ENV === 'development'
      const explicitlyEnabled = process.env.ENABLE_UNSEEN_MESSAGE_LISTENER === 'true'
      const shouldStartListener = !isDev || explicitlyEnabled

      if (!shouldStartListener) {
        if (isDev) {
          logger.info(
            "Unseen-message listener disabled in development by default. " +
            "Set ENABLE_UNSEEN_MESSAGE_LISTENER=true in .env to enable."
          )
        }
      } else {
        const chatListenerLease = getRedisUrl()
          ? await acquireLeaderLease("doxa:leader:unseen-messages")
          : async () => { };

        if (chatListenerLease) {
          cleanupTasks.push(chatListenerLease);
          const detachUnseenMessageListener = await startUnseenMessageListener();
          cleanupTasks.push(detachUnseenMessageListener);
        } else {
          logger.info("Another worker owns the unseen-messages listener lease");
        }
      }
    }

    {
      const isDev = process.env.ENV === 'development'
      const explicitlyEnabled = process.env.ENABLE_CONSULTATION_FEEDBACK_LISTENER === 'true'
      const shouldStartListener = !isDev || explicitlyEnabled

      if (!shouldStartListener) {
        if (isDev) {
          logger.info(
            "Consultation feedback listener disabled in development by default. " +
            "Set ENABLE_CONSULTATION_FEEDBACK_LISTENER=true in .env to enable."
          )
        }
      } else {
        const feedbackListenerLease = getRedisUrl()
          ? await acquireLeaderLease("doxa:leader:consultation-feedback")
          : async () => { };

        if (feedbackListenerLease) {
          cleanupTasks.push(feedbackListenerLease);
          const detachFeedbackListener = await startConsultationFeedbackListener();
          cleanupTasks.push(detachFeedbackListener);
        } else {
          logger.info("Another worker owns the consultation-feedback listener lease");
        }
      }
    }

    if (getRedisUrl()) {
      cleanupTasks.push(await startRedisJobWorker());
    } else {
      logger.warn(
        "REDIS_URL is not configured; using legacy single-instance scheduling"
      );
      await Promise.all([
        restoreUnSeenMessageJobs(),
        restorePendingTransactionJobs(),
        restorePendingTransactionExpiryJobs()
      ]);
      scheduleDailyStatsJob();
      scheduleRetentionAndFollowUpJobs();
      scheduleConsultationStartReminderJob();
      scheduleConsultationSweepJob();
    }

    const PORT = process.env.PORT;

    // Apply middleware
    app.use(loggingMiddleware);
    app.get("/health", healthCheck);
    app.get("/", (_req, res) => {
      res.json({ message: "Worker Service is running!" });
    });

    // Apply error handling
    app.use(errorHandler);

    // Setup cleanup handlers
    setupCleanupHandlers(cleanupTasks);

    // Start server
    app.listen(PORT, () => {
      logger.info(`Worker Server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error("Failed to start worker:", error);
    process.exit(1);
  }
}

startServer();
