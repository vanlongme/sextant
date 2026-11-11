import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { points, T0 } from "../../test/metrics";
import { clockTime } from "./format";
import { TimeChart, type TimeChartProps } from "./TimeChart";

function props(over: Partial<TimeChartProps> = {}): TimeChartProps {
  return {
    stem: "cpu",
    title: "CPU",
    sub: "all containers",
    unit: "cores",
    main: { name: "Usage", points: points([0.2, 0.4, 0.3]) },
    mirror: null,
    refs: [{ name: "Request", points: points([0.5, 0.5, 0.5]) }],
    domain: { start: T0, end: T0 + 120, step: 60 },
    period: "1 hour",
    days: false,
    missing: [],
    emptyText: "No samples in this range.",
    view: "chart",
    ...over,
  };
}

const plot = () => screen.getByTestId("metrics-chart-cpu-plot");
const readout = () => screen.queryByTestId("metrics-chart-cpu-readout");
const time = () => readout()?.querySelector(".readoutTime")?.textContent;
const rows = () =>
  [...(readout()?.querySelectorAll(".row") ?? [])].map((r) => r.textContent);
const dots = () => plot().querySelectorAll(".dot").length;
const press = (key: string) => fireEvent.keyDown(plot(), { key });
const focus = () => act(() => plot().focus());

test("focus selects the last sample and reads every series", () => {
  render(<TimeChart {...props()} />);
  expect(readout()).toBeNull();

  focus();

  expect(time()).toBe(clockTime(T0 + 120));
  expect(rows()).toEqual(["300m Usage", "500m Request"]);
  expect(dots()).toBe(1);
  expect(readout()?.classList.contains("flip")).toBe(true);
  expect(plot().querySelector<HTMLElement>(".hairline")?.style.left).toBe(
    "100%",
  );
});

test("Left and Right move one sample and stop at the ends", () => {
  render(<TimeChart {...props()} />);
  focus();

  expect(press("ArrowLeft")).toBe(false);
  expect(time()).toBe(clockTime(T0 + 60));
  expect(rows()).toEqual(["400m Usage", "500m Request"]);
  expect(readout()?.classList.contains("flip")).toBe(false);

  press("ArrowLeft");
  press("ArrowLeft");
  expect(time()).toBe(clockTime(T0));
  expect(rows()[0]).toBe("200m Usage");

  press("ArrowRight");
  expect(time()).toBe(clockTime(T0 + 60));
  press("ArrowRight");
  press("ArrowRight");
  expect(time()).toBe(clockTime(T0 + 120));
});

test("Home and End go to the first and last sample", () => {
  render(<TimeChart {...props()} />);
  focus();

  press("Home");
  expect(time()).toBe(clockTime(T0));
  press("End");
  expect(time()).toBe(clockTime(T0 + 120));
});

test("Esc hides the readout until the next key, and lets a second Esc through", () => {
  const seen: string[] = [];
  render(
    // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the drawer's Escape handler.
    <div onKeyDown={(e) => seen.push(e.key)}>
      <TimeChart {...props()} />
    </div>,
  );
  focus();

  expect(press("Escape")).toBe(false);
  expect(readout()).toBeNull();
  expect(seen).toEqual([]);

  press("Escape");
  expect(seen).toEqual(["Escape"]);

  press("ArrowLeft");
  expect(time()).toBe(clockTime(T0 + 60));
});

test("hovering selects the nearest sample, and leaving clears it unless focused", () => {
  render(<TimeChart {...props()} />);
  vi.spyOn(plot(), "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 100, y: 0, width: 400, height: 140 }),
  );

  fireEvent.pointerMove(plot(), { clientX: 310 });
  expect(time()).toBe(clockTime(T0 + 60));
  expect(rows()[0]).toBe("400m Usage");

  fireEvent.pointerMove(plot(), { clientX: 120 });
  expect(time()).toBe(clockTime(T0));

  fireEvent.pointerLeave(plot());
  expect(readout()).toBeNull();

  focus();
  fireEvent.pointerMove(plot(), { clientX: 120 });
  fireEvent.pointerLeave(plot());
  expect(time()).toBe(clockTime(T0));

  act(() => plot().blur());
  expect(readout()).toBeNull();
});

test("a mirrored chart reads both halves and dots both lines", () => {
  render(
    <TimeChart
      {...props({
        unit: "bytesPerSecond",
        main: { name: "Received", points: points([1024, 2048]) },
        mirror: { name: "Sent", points: points([512, 1024]) },
        refs: [],
        domain: { start: T0, end: T0 + 60, step: 60 },
      })}
    />,
  );
  focus();

  expect(rows()).toEqual(["2 KiB/s Received", "1 KiB/s Sent"]);
  expect(dots()).toBe(2);
});

test("the readout and the table say no data for a missing series", () => {
  const network = props({
    unit: "bytesPerSecond",
    main: { name: "Received", points: points([1024, 2048, 3072]) },
    mirror: { name: "Sent", points: [] },
    refs: [],
    missing: ["Sent"],
  });
  const { unmount } = render(<TimeChart {...network} />);
  focus();
  expect(rows()).toEqual(["3 KiB/s Received", "no data Sent"]);
  expect(dots()).toBe(1);
  unmount();

  const gappy = props({
    refs: [{ name: "Request", points: points([0.5, null, 0.5]) }],
  });
  const second = render(<TimeChart {...gappy} />);
  focus();
  press("ArrowLeft");
  expect(rows()).toEqual(["400m Usage", "no data Request"]);
  second.unmount();

  render(<TimeChart {...network} view="table" />);
  const table = screen.getByTestId("metrics-table-cpu");
  expect([...table.querySelectorAll("th")].map((th) => th.textContent)).toEqual(
    ["Time", "Received", "Sent"],
  );
  expect([...table.querySelectorAll("tbody tr")][0].textContent).toBe(
    `${clockTime(T0 + 120)}3 KiB/sno data`,
  );
});

test("the table lists the 12 newest samples, newest first", () => {
  const values = Array.from({ length: 15 }, (_, i) => (i + 1) / 10);
  render(
    <TimeChart
      {...props({
        main: { name: "Usage", points: points(values) },
        refs: [{ name: "Request", points: points(values.map(() => 2)) }],
        domain: { start: T0, end: T0 + 14 * 60, step: 60 },
        view: "table",
      })}
    />,
  );

  const table = screen.getByTestId("metrics-table-cpu");
  const body = [...table.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.textContent),
  );
  expect(body).toHaveLength(12);
  expect(body[0]).toEqual([clockTime(T0 + 14 * 60), "1.5 cores", "2 cores"]);
  expect(body[11]).toEqual([clockTime(T0 + 3 * 60), "400m", "2 cores"]);
  expect(screen.queryByTestId("metrics-chart-cpu-plot")).toBeNull();
  expect(screen.getByTestId("metrics-chart-cpu-now").textContent).toBe(
    "1.5 cores",
  );
});

test("the table of a series with no point shows the empty text", () => {
  render(
    <TimeChart
      {...props({ main: { name: "Usage", points: [] }, view: "table" })}
    />,
  );

  expect(screen.queryByTestId("metrics-table-cpu")).toBeNull();
  expect(screen.getByTestId("metrics-chart-cpu-empty").textContent).toBe(
    "No samples in this range.",
  );
});

test("an empty chart takes focus but shows no readout", () => {
  render(<TimeChart {...props({ main: { name: "Usage", points: [] } })} />);
  focus();
  press("ArrowLeft");

  expect(readout()).toBeNull();
  expect(press("Escape")).toBe(true);
});
