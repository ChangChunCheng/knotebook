// Registered only with config.testHooks (KNOTEBOOK_E2E_TEST_HOOKS=1 and a loopback PUBLIC_URL), else 404; seconds: null clears the override (back to the
// configured or site value). Overrides this process's scanner only.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendInvalidBody } from "../auth/admin-provider-input.js";
import type { VersionService } from "../collab/versions.js";

const autoWaitBodySchema = z.object({ seconds: z.number().int().min(1).max(3600).nullable() }).strict();

export function testHookRoutes(deps: { versions: VersionService }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.put("/api/admin/test/version-auto-wait", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = autoWaitBodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      deps.versions.overrideAutoWaitMs(parsed.data.seconds === null ? null : parsed.data.seconds * 1000);
      return reply.code(204).send();
    });
  };
}
