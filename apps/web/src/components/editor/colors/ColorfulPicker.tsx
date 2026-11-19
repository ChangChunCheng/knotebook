import { useLayoutEffect, useRef } from "react";
import { HexColorPicker } from "react-colorful";
import "./panel.css";

interface ColorfulPickerProps {
  color: string | undefined;
  onChange(hex: string): void;
  saturationLabel: string;
  hueLabel: string;
}

/**
 * The only importer of `react-colorful` (lazy-loaded by `CustomColorPanel`, so the package stays in this chunk).
 * Its sliders hard-code an English `aria-label`: overridden after every render, since React only rewrites the DOM when a prop value changes and the library's value is constant.
 * No deps array, so a language change also updates it.
 */
export default function ColorfulPicker({ color, onChange, saturationLabel, hueLabel }: ColorfulPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const sliders = ref.current?.querySelectorAll('[role="slider"]');
    sliders?.[0]?.setAttribute("aria-label", saturationLabel);
    sliders?.[1]?.setAttribute("aria-label", hueLabel);
  });
  return (
    <div ref={ref}>
      <HexColorPicker color={color} onChange={onChange} />
    </div>
  );
}
