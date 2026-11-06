import { baseColumns, numberColumn, textColumn } from "../columns";
import { registerKind } from "../registry";
import { ConfigMapDetail } from "./ConfigMapDetail";
import { keyCount } from "./dataEdits";
import { SecretDetail } from "./SecretDetail";

registerKind("", "configmaps", {
  columns: (info) =>
    baseColumns(
      info.resource,
      numberColumn(
        "data",
        "Data",
        (o) => keyCount(o.data) + keyCount(o.binaryData),
      ),
    ),
  detail: ConfigMapDetail,
});

registerKind("", "secrets", {
  columns: (info) =>
    baseColumns(
      info.resource,
      textColumn("type", "Type", (o) => o.type),
      numberColumn("data", "Data", (o) => keyCount(o.data)),
    ),
  detail: SecretDetail,
});
