import type { Instrumentation } from "next";
import { requestErrorLine } from "@/lib/logs/request-error";

/**
 * Every uncaught server error (render, route handler, server action, proxy) is printed as one
 * tagged line naming the user it happened to (`lib/logs/request-error.ts`). The Vercel drain
 * stores it in `platform_logs`. Printing only: nothing here can fail the request further.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    console.error(requestErrorLine({ error, request, context }));
  } catch {
    // Reporting must never mask the error being reported.
  }
};
