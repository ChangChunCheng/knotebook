import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { BUILTIN_ACTION_IDS, INSTRUCT_ACTION_ID } from "@knotebook/shared";
import { freshDb } from "./helpers.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedAiActions } from "../src/db/seed-ai.js";
import { aiActions } from "../src/db/schema.js";

describe("seedAiActions (idempotent seed of the five builtin actions, #263)", () => {
  it("running twice still yields five rows whose ids are exactly BUILTIN_ACTION_IDS", async () => {
    const { db } = await freshDb(); // freshDb() already ran the seed once via runMigrations()
    await seedAiActions(db);

    const rows = await db.select().from(aiActions);
    expect(rows.map((r) => r.id).sort()).toEqual([...BUILTIN_ACTION_IDS].sort());
    expect(rows).toHaveLength(5);
  });

  it("name/applyMode follow the builtin table: the five builtin actions always install as preview on a new install (#263 follow-up: Rewrite/Translate changed from direct to preview)", async () => {
    const { db } = await freshDb();
    const rows = await db.select().from(aiActions);
    const byName = new Map(rows.map((r) => [r.name, r]));

    expect(byName.get("Rewrite")).toMatchObject({ applyMode: "preview" });
    expect(byName.get("Translate")).toMatchObject({ applyMode: "preview" });
    expect(byName.get("Summarize")).toMatchObject({ applyMode: "preview" });
    expect(byName.get("Continue writing")).toMatchObject({ applyMode: "preview" });
    expect(byName.get("Instruct")).toMatchObject({ applyMode: "preview" });
    expect(byName.size).toBe(5);
  });

  it("#263 Instruct defaults: system prompt, a template with three placeholders (instruction/focus/text, one line each), preview, sortOrder 4, modelId null, enabled", async () => {
    const { db } = await freshDb();
    const [row] = await db.select().from(aiActions).where(eq(aiActions.id, INSTRUCT_ACTION_ID));
    expect(row).toMatchObject({
      name: "Instruct",
      systemPrompt:
        "You are an expert editor working on a note. Follow the user's instruction for the given text, preserving its language and Markdown formatting unless the instruction says otherwise.",
      userTemplate: "{{instruction}}\n{{focus}}\n{{text}}",
      applyMode: "preview",
      sortOrder: 4,
      modelId: null,
      enabled: true,
    });
  });

  it("re-running the seed after admin edits (Rewrite's systemPrompt + disabled, Instruct's template) neither overwrites nor revives", async () => {
    const { db } = await freshDb();
    const [rewrite] = await db.select().from(aiActions).where(eq(aiActions.name, "Rewrite"));
    expect(rewrite).toBeDefined();

    // applyMode counts too: an existing direct (left by an existing site or admin) isn't overwritten by the new default preview (upgrades don't change existing sites' values).
    await db
      .update(aiActions)
      .set({ systemPrompt: "已由 admin 改寫過的 system prompt", enabled: false, applyMode: "direct" })
      .where(eq(aiActions.id, rewrite!.id));
    await db.update(aiActions).set({ userTemplate: "{{text}} / {{instruction}}" }).where(eq(aiActions.id, INSTRUCT_ACTION_ID));

    // Re-run the seed (simulates the next startup's runMigrations) - ON CONFLICT (id) DO NOTHING must not overwrite.
    await seedAiActions(db);
    await runMigrations(db); // also re-run the whole migrate path, to make sure the seed call site is idempotent too

    const [afterRewrite] = await db.select().from(aiActions).where(eq(aiActions.id, rewrite!.id));
    expect(afterRewrite).toMatchObject({ systemPrompt: "已由 admin 改寫過的 system prompt", enabled: false, applyMode: "direct" });
    const [afterInstruct] = await db.select().from(aiActions).where(eq(aiActions.id, INSTRUCT_ACTION_ID));
    expect(afterInstruct?.userTemplate).toBe("{{text}} / {{instruction}}");

    const rows = await db.select().from(aiActions);
    expect(rows).toHaveLength(5);
  });
});
