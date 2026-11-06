import { vi } from "vitest";

/**
 * Gives every element a size, since jsdom has no layout and a virtualized table
 * shows no rows in a viewport of 0 px. Undo it with `vi.restoreAllMocks()`.
 */
export function mockElementSize(width = 1000, height = 600): void {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(height);
}
