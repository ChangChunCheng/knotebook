import { COVER_ID } from "./slides";

export interface SlideStructure {
  id: string;
  slides: readonly { id: string }[];
}

export function locateSlide(sections: readonly SlideStructure[], id: string): { h: number; v: number } | null {
  for (let h = 0; h < sections.length; h++) {
    const v = sections[h].slides.findIndex((slide) => slide.id === id);
    if (v !== -1) return { h, v };
  }
  return null;
}

/** Fallback order: the current slide → the slide just before it in the old structure → the first slide of its old chapter → the cover. */
export function repositionAfterUpdate(
  oldSections: readonly SlideStructure[],
  oldCurrentId: string,
  newSections: readonly SlideStructure[],
): { h: number; v: number; id: string } {
  const at = (id: string) => {
    const pos = locateSlide(newSections, id);
    return pos ? { ...pos, id } : null;
  };

  const current = at(oldCurrentId);
  if (current) return current;

  const old = locateSlide(oldSections, oldCurrentId);
  if (old) {
    const previous =
      old.v > 0
        ? oldSections[old.h].slides[old.v - 1]
        : old.h > 0
          ? oldSections[old.h - 1].slides[oldSections[old.h - 1].slides.length - 1]
          : undefined;
    if (previous) {
      const hit = at(previous.id);
      if (hit) return hit;
    }
    const first = at(oldSections[old.h].slides[0].id);
    if (first) return first;
  }
  return { h: 0, v: 0, id: COVER_ID };
}
