import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Switch } from "./switch";

/**
 * The checked state must carry the `data-[state=checked]:bg-brand` class token. Tailwind writes the whole arbitrary-variant name into `class` as is,
 * and CSS uses the `[data-state=checked]` attribute selector to decide when it applies, so the class name is present in every state:
 * what this guards is that the token has not been removed.
 */
describe("Switch checked-state theme color (style guard)", () => {
  it("carries the data-[state=checked]:bg-brand class (removing it would drift silently)", () => {
    // `defaultChecked` rather than `checked readOnly`: Radix Switch has no `readOnly` prop, and the controlled form needs `onCheckedChange`.
    // vitest runs through esbuild, which strips types, so the test stays green; only `tsc --noEmit` catches it.
    render(<Switch defaultChecked />);
    expect(screen.getByRole("switch")).toHaveClass("data-[state=checked]:bg-brand");
  });
});
