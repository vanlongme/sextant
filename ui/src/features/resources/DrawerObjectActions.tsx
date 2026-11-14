import { type ReactElement, useState } from "react";
import type { ApiResourceInfo } from "../../ipc/generated/ApiResourceInfo";
import type { KubeObject } from "../../kinds/objects";
import { kindSpec } from "../../kinds/registry";
import { DeleteDialog } from "./DeleteDialog";
import { ObjectActionBar } from "./ObjectActionBar";
import { objectActions } from "./objectActions";
import { useActionContext } from "./ResourceActions";

/**
 * The drawer's actions for an object of another kind than the screen's (spec H51), with
 * its own confirm dialog, kind dialogs and Delete dialog.
 */
export function DrawerObjectActions(props: {
  clusterId: string;
  info: ApiResourceInfo;
  object: KubeObject;
}): ReactElement {
  const { clusterId, info, object } = props;
  const { resource } = info;
  const { context, confirmDialog } = useActionContext(clusterId, resource);
  const [deleting, setDeleting] = useState<KubeObject[] | null>(null);
  const spec = kindSpec(resource.group, resource.plural);
  const KindDeleteDialog = spec?.deleteDialog ?? DeleteDialog;
  return (
    <>
      <ObjectActionBar
        items={objectActions({
          object,
          kindActions: spec?.actions ?? [],
          info,
          context,
          onDelete: (o) => setDeleting([o]),
        })}
      />
      {deleting ? (
        <KindDeleteDialog
          clusterId={clusterId}
          resource={resource}
          objects={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => setDeleting(null)}
        />
      ) : null}
      {confirmDialog}
    </>
  );
}
