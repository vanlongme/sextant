import type { TableColumn } from "../../design/VirtualTable";
import { baseColumns, statusColumn, textColumn } from "../columns";
import type { KubeObject } from "../objects";
import { registerKind } from "../registry";
import { ApplicationDeleteDialog } from "./ApplicationDeleteDialog";
import { ApplicationDetail } from "./ApplicationDetail";
import { ApplicationSetDetail } from "./ApplicationSetDetail";
import { AppProjectDetail } from "./AppProjectDetail";
import { APPLICATION_ACTIONS } from "./actions";
import {
  healthStatus,
  revisionText,
  revisionTitle,
  syncStatus,
} from "./application";
import { generatedCount, generatorText } from "./applicationSet";
import {
  destinationsText,
  destinationsTitle,
  sourceReposText,
  sourceReposTitle,
} from "./appProject";
import { ARGO_GROUP, NONE, text } from "./common";

/** A text cell that is never empty, with a title that may say more. */
function titledColumn(
  id: string,
  header: string,
  get: (o: KubeObject) => string,
  title: (o: KubeObject) => string,
): TableColumn<KubeObject> {
  return {
    id,
    header,
    width: "minmax(120px, 1fr)",
    sortValue: get,
    render: (o) => <span title={title(o)}>{get(o)}</span>,
  };
}

const generatedColumn: TableColumn<KubeObject> = {
  id: "applications",
  header: "Applications",
  width: 110,
  // Null sorts last in both directions, like the "—" it shows.
  sortValue: (o) => generatedCount(o),
  render: (o) => {
    const count = generatedCount(o);
    return count === null ? NONE : String(count);
  },
};

// Argo CD has its own sidebar section (spec G §3.1); its kinds are read here (§4, §5).
registerKind(ARGO_GROUP, "applications", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn(
        "project",
        "Project",
        (o) => text(o.spec?.project) ?? "default",
      ),
      statusColumn(syncStatus, { id: "sync", header: "Sync" }),
      statusColumn(healthStatus, { id: "health", header: "Health" }),
      titledColumn("revision", "Revision", revisionText, revisionTitle),
    ),
  actions: APPLICATION_ACTIONS,
  detail: ApplicationDetail,
  deleteDialog: ApplicationDeleteDialog,
});

registerKind(ARGO_GROUP, "applicationsets", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("generators", "Generators", generatorText),
      generatedColumn,
    ),
  detail: ApplicationSetDetail,
});

registerKind(ARGO_GROUP, "appprojects", {
  columns: (info) =>
    baseColumns(
      info.resource,
      titledColumn(
        "destinations",
        "Destinations",
        destinationsText,
        destinationsTitle,
      ),
      titledColumn("sources", "Sources", sourceReposText, sourceReposTitle),
    ),
  detail: AppProjectDetail,
});
