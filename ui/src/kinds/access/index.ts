import { baseColumns, numberColumn, textColumn } from "../columns";
import { registerKind } from "../registry";
import {
  RoleBindingDetail,
  RoleDetail,
  ServiceAccountDetail,
} from "./AccessDetails";
import { subjectsText } from "./access";

const RBAC = "rbac.authorization.k8s.io";

registerKind("", "serviceaccounts", {
  columns: (info) =>
    baseColumns(
      info.resource,
      numberColumn("secrets", "Secrets", (o) =>
        Array.isArray(o.secrets) ? o.secrets.length : 0,
      ),
    ),
  detail: ServiceAccountDetail,
});

for (const plural of ["roles", "clusterroles"]) {
  registerKind(RBAC, plural, {
    columns: (info) =>
      baseColumns(
        info.resource,
        numberColumn("rules", "Rules", (o) =>
          Array.isArray(o.rules) ? o.rules.length : 0,
        ),
      ),
    detail: RoleDetail,
  });
}

for (const plural of ["rolebindings", "clusterrolebindings"]) {
  registerKind(RBAC, plural, {
    columns: (info) =>
      baseColumns(
        info.resource,
        textColumn("role", "Role", (o) =>
          o.roleRef?.name ? `${o.roleRef.kind}/${o.roleRef.name}` : undefined,
        ),
        textColumn("subjects", "Subjects", (o) => subjectsText(o.subjects)),
      ),
    detail: RoleBindingDetail,
  });
}
