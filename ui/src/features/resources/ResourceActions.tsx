import { Ellipsis } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button, ConfirmDialog, Menu, toast } from "../../design";
import { failureMessage } from "../../ipc/client";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { ResourceRef } from "../../ipc/generated/ResourceRef";
import type { KubeObject } from "../../kinds/objects";
import type { ActionContext, KindAction } from "../../kinds/registry";
import { editTab, useDock } from "../../stores/dock";

type ConfirmOptions = Parameters<ActionContext["confirm"]>[0];

/** The context kind actions run with, and the dialog its `confirm` opens. */
export function useActionContext(
  clusterId: string,
  resource: ResourceRef,
): { context: ActionContext; confirmDialog: ReactNode } {
  const navigate = useNavigate();
  const [custom, setCustom] = useState<ReactNode>(null);
  const [asking, setAsking] = useState<{
    options: ConfirmOptions;
    answer(yes: boolean): void;
  } | null>(null);

  const context = useMemo<ActionContext>(
    () => ({
      clusterId,
      resource,
      navigate: (to) => {
        void navigate(to);
      },
      confirm: (options) =>
        new Promise((resolve) => {
          setAsking({
            options,
            answer: (yes) => {
              setAsking(null);
              resolve(yes);
            },
          });
        }),
      dialog: (render) => setCustom(render(() => setCustom(null))),
      openEditor: (object) =>
        useDock
          .getState()
          .open(
            editTab(
              clusterId,
              resource,
              object.metadata.namespace,
              object.metadata.name,
            ),
          ),
    }),
    [clusterId, resource, navigate],
  );

  const confirmElement = asking ? (
    <ConfirmDialog
      open
      title={asking.options.title}
      body={asking.options.body}
      confirmLabel={asking.options.confirmLabel}
      danger={asking.options.danger}
      onConfirm={() => asking.answer(true)}
      onCancel={() => asking.answer(false)}
    />
  ) : null;

  return {
    context,
    confirmDialog: (
      <>
        {confirmElement}
        {custom}
      </>
    ),
  };
}

async function runAction(
  action: KindAction,
  context: ActionContext,
  object: KubeObject,
): Promise<void> {
  try {
    await action.run(context, object);
  } catch (error) {
    toast.error(`${action.label} failed`, failureMessage(error));
  }
}

/** The menu at the end of a row: the kind's own actions, then Edit YAML and Delete. */
export function RowActions(props: {
  object: KubeObject;
  actions: KindAction[];
  context: ActionContext;
  info: ApiResourceInfo;
  onDelete(object: KubeObject): void;
}) {
  const { object, context, info } = props;
  const { name } = object.metadata;
  return (
    <Menu
      trigger={
        // No Tooltip here: closing the menu returns focus to this button,
        // and a tooltip opened by that focus would cover the row above.
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Actions for ${name}`}
          title="Actions"
          data-testid={`row-menu-${name}`}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </Button>
      }
      items={[
        ...props.actions
          .filter((a) => a.visible?.(object) ?? true)
          .map((a) => ({
            id: a.id,
            label: a.label,
            danger: a.danger,
            disabled:
              a.requires === "patch"
                ? !info.canPatch
                : a.requires === "update"
                  ? !info.canUpdate
                  : false,
            onSelect: () => void runAction(a, context, object),
          })),
        {
          id: "edit",
          label: "Edit YAML",
          onSelect: () => context.openEditor(object),
        },
        {
          id: "delete",
          label: "Delete",
          danger: true,
          disabled: !info.canDelete,
          onSelect: () => props.onDelete(object),
        },
      ]}
    />
  );
}
