import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  clearMocks();
});

// Browser APIs that jsdom lacks and Radix or dnd-kit expect.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);
window.matchMedia ??= (media: string) =>
  ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList;
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
