import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { IpcFailure } from "../../ipc/client";
import { flush } from "../../test/ipc";
import { useFetch } from "./useFetch";

test("reads once per key, waits on a null key, and drops an older key's answer", async () => {
  const asked: string[] = [];
  const answers = new Map<string, (value: string) => void>();
  const { result, rerender } = renderHook(
    ({ id }: { id: string | null }) =>
      useFetch(id, () => {
        asked.push(id ?? "");
        return new Promise<string>((resolve) => answers.set(id ?? "", resolve));
      }),
    { initialProps: { id: null as string | null } },
  );
  expect(result.current).toMatchObject({ value: undefined, loading: false });
  expect(asked).toEqual([]);

  rerender({ id: "a" });
  expect(result.current.loading).toBe(true);
  rerender({ id: "b" });
  await act(async () => {
    answers.get("a")?.("old");
    answers.get("b")?.("new");
    await flush();
  });
  expect(asked).toEqual(["a", "b"]);
  expect(result.current).toMatchObject({ value: "new", loading: false });
  rerender({ id: "b" });
  expect(asked).toEqual(["a", "b"]);
});

test("a failure is kept as an IpcFailure, and retry reads again", async () => {
  let fail = true;
  const { result } = renderHook(() =>
    useFetch("k", () =>
      fail
        ? Promise.reject(new IpcFailure("NotFound", "gone"))
        : Promise.resolve(1),
    ),
  );
  await act(flush);
  expect(result.current.error).toMatchObject({
    code: "NotFound",
    message: "gone",
  });
  fail = false;
  act(() => result.current.retry());
  await act(flush);
  expect(result.current).toMatchObject({ value: 1, error: null });
});
