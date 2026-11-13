import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapPanes } from "./MapPanes";
import {
  goneText,
  MapEmpty,
  MapError,
  MapLoading,
  MapNote,
  noMatchText,
  tooManyText,
} from "./MapStates";

const width = () =>
  Number.parseInt(
    (screen.getByText("details").parentElement as HTMLElement).style.width,
    10,
  );

describe("MapPanes", () => {
  it("shows no details pane without details", () => {
    render(<MapPanes canvas={<p>canvas</p>} details={null} />);
    expect(screen.getByText("canvas")).toBeTruthy();
    expect(screen.queryByTestId("map-details-resize")).toBeNull();
  });

  it("starts the details at 320px and keeps them between 260 and 520px", () => {
    render(<MapPanes canvas={<p>canvas</p>} details={<p>details</p>} />);
    expect(width()).toBe(320);
    const handle = screen.getByTestId("map-details-resize");
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    for (let i = 0; i < 20; i++)
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(width()).toBe(520);
    for (let i = 0; i < 30; i++)
      fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(width()).toBe(260);
    fireEvent.pointerDown(handle, { button: 0, clientX: 700 });
    fireEvent.pointerMove(window, { clientX: 600 });
    fireEvent.pointerUp(window);
    expect(width()).toBe(360);
  });
});

describe("map states", () => {
  it("reads the spec's texts", () => {
    const retry = vi.fn();
    render(
      <>
        <MapLoading />
        <MapError message="discovery failed" onRetry={retry} />
        <MapEmpty text={goneText("Deployment", "web")} />
        <MapNote text={tooManyText(1742)} />
        <MapNote text={noMatchText(" zzz ")} />
      </>,
    );
    expect(screen.getByTestId("map-loading").textContent).toBe(
      "Reading resources…",
    );
    const error = screen.getByTestId("map-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      "The map could not be built: discovery failedRetry",
    );
    fireEvent.click(screen.getByTestId("map-retry"));
    expect(retry).toHaveBeenCalled();
    expect(screen.getByTestId("map-empty").textContent).toBe(
      "Deployment web no longer exists.",
    );
    expect(screen.getAllByTestId("map-note").map((n) => n.textContent)).toEqual(
      [
        "1,742 resources in the selected namespaces. Hide some namespaces to draw the map.",
        "No resource matches “zzz”.",
      ],
    );
    expect(screen.getAllByRole("note")).toHaveLength(2);
  });
});
