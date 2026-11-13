import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ORDER } from "../layout/constants";
import { iconName, KindIcon } from "./KindIcon";
import { K8S_ICONS } from "./k8sIcons";

const SET = [
  "pod",
  "deploy",
  "rs",
  "sts",
  "ds",
  "job",
  "cronjob",
  "svc",
  "ing",
  "cm",
  "secret",
  "sa",
  "pvc",
  "ns",
  "crd",
] as const;

describe("k8sIcons", () => {
  it("packs the 15 icons of the set as path data", () => {
    expect(Object.keys(K8S_ICONS).sort()).toEqual([...SET].sort());
    for (const name of SET) {
      const icon = K8S_ICONS[name];
      expect(icon.vb, name).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
      expect(icon.paths.length, name).toBeGreaterThan(0);
      for (const p of icon.paths) {
        expect(p.d, name).toMatch(/^\s*[Mm]/);
        expect(p.s, name).toMatch(/^fill:/);
      }
    }
  });
});

describe("KindIcon", () => {
  it("gives every kind of the map an icon of its own", () => {
    for (const kind of [...Object.keys(ORDER), "Namespace"]) {
      expect(iconName(kind), kind).not.toBe("crd");
    }
    expect(iconName("Pod")).toBe("pod");
    expect(iconName("PersistentVolumeClaim")).toBe("pvc");
    expect(iconName("Gateway")).toBe("Gateway");
  });

  it("draws an unknown kind with the crd icon", () => {
    expect(iconName("Widget")).toBe("crd");
    const { container } = render(
      <svg aria-hidden="true">
        <KindIcon kind="Widget" size={44} />
      </svg>,
    );
    const icon = container.querySelector("svg svg");
    expect(icon?.getAttribute("data-icon")).toBe("crd");
    expect(icon?.querySelectorAll("path")).toHaveLength(
      K8S_ICONS.crd.paths.length,
    );
  });

  it("is hidden from assistive technology at the given size", () => {
    const { container } = render(
      <svg aria-hidden="true">
        <KindIcon kind="Pod" size={64} x={3} y={4} />
      </svg>,
    );
    const icon = container.querySelector("svg svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("width")).toBe("64");
    expect(icon?.getAttribute("x")).toBe("3");
    expect(icon?.getAttribute("viewBox")).toBe(K8S_ICONS.pod.vb);
  });

  it("puts a white glyph in the frame for the Gateway API kinds", () => {
    const { container } = render(
      <svg aria-hidden="true">
        <KindIcon kind="HTTPRoute" size={44} />
        <KindIcon kind="LoadBalancer" size={44} />
      </svg>,
    );
    const [route, lb] = container.querySelectorAll("svg > svg");
    expect(route.querySelector("svg")?.getAttribute("stroke")).toBe("#ffffff");
    expect(lb.getAttribute("data-icon")).toBe("LoadBalancer");
    expect(lb.querySelector("g")?.getAttribute("transform")).toMatch(
      /^rotate\(90 /,
    );
  });
});
