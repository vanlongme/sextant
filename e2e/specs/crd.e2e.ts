import {
  createTestNamespace,
  deleteTestNamespace,
  kubectl,
} from "../helpers/kube";
import {
  byTestId,
  expectConnected,
  gone,
  openCluster,
  openResource,
  rowId,
  shown,
  tableHeaders,
} from "../helpers/ui";

const KIND = "kind-skopos-e2e";
const NS = "skopos-test-e2e";
const GROUP = "e2e.skopos.test";
const CRD_NAME = `widgets.${GROUP}`;
const NAV_ITEM = `nav-item-${GROUP}-widgets`;

const CRD = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${CRD_NAME}
spec:
  group: ${GROUP}
  scope: Namespaced
  names:
    kind: Widget
    plural: widgets
    singular: widget
  versions:
    - name: v1
      served: true
      storage: true
      additionalPrinterColumns:
        - name: Flavor
          type: string
          jsonPath: .spec.flavor
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                flavor:
                  type: string
`;

const INSTANCE = `
apiVersion: ${GROUP}/v1
kind: Widget
metadata:
  name: one
  namespace: ${NS}
spec:
  flavor: e2e-mint
`;

describe("custom resources", () => {
  before(async () => {
    await kubectl([
      "delete",
      "crd",
      CRD_NAME,
      "--ignore-not-found",
      "--wait=true",
    ]);
    await createTestNamespace(NS);
    await openCluster(KIND);
  });

  after(async () => {
    await kubectl([
      "delete",
      "crd",
      CRD_NAME,
      "--ignore-not-found",
      "--wait=true",
    ]);
    await deleteTestNamespace(NS);
  });

  it("adds a CRD to the sidebar live", async () => {
    await shown("cluster-sidebar");
    expect(await byTestId(`nav-crd-group-${GROUP}`).isExisting()).toBe(false);

    await kubectl(["apply", "-f", "-"], CRD);

    await shown(`nav-crd-group-${GROUP}`, 30000);
    // CRD groups start closed (spec G §3.3); a saved state may already have it open.
    const toggle = await shown(`nav-crd-toggle-${GROUP}`);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    await shown(NAV_ITEM);
  });

  it("lists instances with printer columns", async () => {
    await kubectl(["apply", "-f", "-"], INSTANCE);

    await openResource(NAV_ITEM, "Widget");
    const row = await shown(rowId(NS, "one"));

    await browser.waitUntil(
      async () => (await tableHeaders()).includes("Flavor"),
      {
        timeout: 15000,
        timeoutMsg: "the printer column never showed",
      },
    );
    await browser.waitUntil(
      async () => (await row.getText()).includes("e2e-mint"),
      {
        timeout: 15000,
        timeoutMsg: "the printer column's value never showed",
      },
    );
  });

  it("shows a clear message when the CRD is deleted while open", async () => {
    await shown(rowId(NS, "one"));

    await kubectl(["delete", "crd", CRD_NAME, "--wait=true"]);

    await browser.waitUntil(
      async () => {
        const status = byTestId("resource-status");
        return (
          (await status.isExisting()) &&
          (await status.getText()).includes("not available")
        );
      },
      {
        timeout: 30000,
        timeoutMsg: "the screen never said the resource is gone",
      },
    );
    await gone(rowId(NS, "one"));

    // The rest of the app carries on.
    await gone(`nav-crd-group-${GROUP}`, 30000);
    await shown("nav-item-core-pods");
    await expectConnected(5000);
    await openResource("nav-item-core-pods", "Pod");
  });
});
