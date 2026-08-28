import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import {
  createScheduledIngestionRouter,
  type ScheduledIngestionStarter,
} from "./routes/scheduled-ingestion";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

export function createApp(
  options: { scheduledIngestionStarter?: ScheduledIngestionStarter } = {},
): Express {
  const app: Express = express();

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );

  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
  app.use(cors({ credentials: true, origin: true }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api", createScheduledIngestionRouter(options.scheduledIngestionStarter));

  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );

  app.use("/api", router);

  return app;
}

export default createApp();
