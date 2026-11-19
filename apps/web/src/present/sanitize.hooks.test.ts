import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ attr: [] as string[] }));

vi.mock("dompurify", async (importOriginal) => {
  const real = (await importOriginal<typeof import("dompurify")>()).default;
  const factory = ((root: Parameters<typeof real>[0]) => {
    const instance = real(root);
    const originalAddHook = instance.addHook.bind(instance);
    instance.addHook = ((name: string, hook: (...args: unknown[]) => void) => {
      if (name !== "uponSanitizeAttribute") return originalAddHook(name as never, hook as never);
      return originalAddHook(name as never, ((node: unknown, data: { attrName: string }, config: unknown) => {
        calls.attr.push(data.attrName);
        return hook(node, data, config);
      }) as never);
    }) as typeof instance.addHook;
    return instance;
  }) as unknown as typeof real;
  Object.assign(factory, real);
  return { default: factory };
});

describe("sanitize's hooks are registered once at module top level", () => {
  it("sanitizing the same input twice: the attribute hook call count = attribute count x 2 (doesn't stack up)", async () => {
    const { sanitizeSlideFragment } = await import("./sanitize");
    sanitizeSlideFragment('<p data-foo="1">x</p>');
    const once = calls.attr.length;
    expect(once).toBe(1);
    sanitizeSlideFragment('<p data-foo="1">x</p>');
    expect(calls.attr.length).toBe(2);
  });
});
