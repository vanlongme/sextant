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
const EXTRA_GROUP = "extra.skopos.test";
const EXTRA_CRD_NAME = `gadgets.${EXTRA_GROUP}`;
const DOMAIN = "skopos.test";

const EXTRA_CRD = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${EXTRA_CRD_NAME}
spec:
  group: ${EXTRA_GROUP}
  scope: Namespaced
  names:
    kind: Gadget
    plural: gadgets
    singular: gadget
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          x-kubernetes-preserve-unknown-fields: true
`;

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
    await kubectl([
      "delete",
      "crd",
      EXTRA_CRD_NAME,
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
    await kubectl([
      "delete",
      "crd",
      EXTRA_CRD_NAME,
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

  it("puts two API groups of one domain under a domain row, and back", async () => {
    await kubectl(["apply", "-f", "-"], EXTRA_CRD);
    const domain = await shown(`nav-crd-domain-toggle-${DOMAIN}`, 30000);
    await browser.waitUntil(
      async () => /^skopos\.test\s*2$/.test(await domain.getText()),
      { timeout: 15000, timeoutMsg: "the domain row never counted two kinds" },
    );
    if ((await domain.getAttribute("aria-expanded")) !== "true") {
      await domain.click();
    }
    expect(await (await shown(`nav-crd-toggle-${GROUP}`)).getText()).toMatch(/^e2e\s*1$/);
    expect(await (await shown(`nav-crd-toggle-${EXTRA_GROUP}`)).getText()).toMatch(
      /^extra\s*1$/,
    );

    await kubectl(["delete", "crd", EXTRA_CRD_NAME, "--wait=true"]);
    await gone(`nav-crd-domain-${DOMAIN}`, 30000);
    // The domain's only group is a "group" row again, under its full name.
    expect(await (await shown(`nav-crd-toggle-${GROUP}`)).getText()).toMatch(
      /^e2e\.skopos\.test\s*1$/,
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
