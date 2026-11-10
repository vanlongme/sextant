import { renderHook } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { resetHelmForTest } from "../../stores/helm";
import { release, releaseList } from "../../test/helm";
import { flush, mockBackend } from "../../test/ipc";
import { useWatchReleases } from "./useReleases";

beforeEach(() => resetHelmForTest());

const LIST = releaseList([release({ name: "web" })]);

test("waits for the selection, asks for it (empty is every namespace) and follows its changes", async () => {
  const backend = mockBackend({ helm_release_list: () => LIST });
  const { result, rerender, unmount } = renderHook(
    ({ namespaces }: { namespaces: string[] | undefined }) =>
      useWatchReleases("c1", namespaces),
    { initialProps: { namespaces: undefined as string[] | undefined } },
  );
  await flush();
  expect(backend.callsTo("helm_release_list")).toEqual([]);

  rerender({ namespaces: [] });
  await flush();
  expect(backend.callsTo("helm_release_list")).toEqual([
    { clusterId: "c1", namespaces: null },
  ]);
  expect(result.current?.list).toEqual(LIST);

  // A new array with the same names does not read again.
  rerender({ namespaces: [] });
  rerender({ namespaces: ["shop"] });
  await flush();
  expect(backend.callsTo("helm_release_list")).toEqual([
    { clusterId: "c1", namespaces: null },
    { clusterId: "c1", namespaces: ["shop"] },
  ]);
  unmount();
});
