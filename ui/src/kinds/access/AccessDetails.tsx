import { Facts, ObjectLink, Part, SimpleTable } from "../detail/parts";
import type { DetailProps } from "../registry";
import { ruleRows, subjectRows } from "./access";

const RBAC_API_VERSION = "rbac.authorization.k8s.io/v1";

function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((v) => (typeof v === "string" ? v : v?.name))
        .filter((n): n is string => typeof n === "string" && n !== "")
    : [];
}

export function ServiceAccountDetail({
  clusterId,
  object,
  resources,
}: DetailProps) {
  const links = (list: string[]) =>
    list.length === 0 ? undefined : (
      <ul>
        {list.map((name) => (
          <li key={name}>
            <ObjectLink
              clusterId={clusterId}
              resources={resources}
              kind="Secret"
              name={name}
              namespace={object.metadata.namespace}
            />
          </li>
        ))}
      </ul>
    );
  const automount: unknown = object.automountServiceAccountToken;
  return (
    <Part title="Service account">
      <Facts
        items={[
          ["Secrets", links(names(object.secrets))],
          ["Image pull secrets", links(names(object.imagePullSecrets))],
          [
            "Automount service account token",
            typeof automount === "boolean" ? String(automount) : undefined,
          ],
        ]}
      />
    </Part>
  );
}

export function RoleDetail({ object }: DetailProps) {
  return (
    <Part title="Rules">
      <SimpleTable
        testId="detail-rules"
        headers={["API groups", "Resources", "Resource names", "URLs", "Verbs"]}
        rows={ruleRows(object.rules).map((r) => [
          r.groups,
          r.resources,
          r.names,
          r.urls,
          r.verbs,
        ])}
        empty="No rules."
      />
    </Part>
  );
}

export function RoleBindingDetail({
  clusterId,
  object,
  resources,
}: DetailProps) {
  const ref = object.roleRef;
  const roleLink = ref?.name ? (
    <ObjectLink
      clusterId={clusterId}
      resources={resources}
      kind={String(ref.kind ?? "Role")}
      name={String(ref.name)}
      // A ClusterRole has no namespace, whatever binds it.
      namespace={
        ref.kind === "ClusterRole" ? undefined : object.metadata.namespace
      }
      apiVersion={RBAC_API_VERSION}
    />
  ) : undefined;
  return (
    <>
      <Part title="Binding">
        <Facts items={[["Role", roleLink]]} />
      </Part>
      <Part title="Subjects">
        <SimpleTable
          testId="detail-subjects"
          headers={["Kind", "Name", "Namespace"]}
          rows={subjectRows(object.subjects).map((s) => [
            s.kind,
            s.linkable ? (
              <ObjectLink
                key={s.name}
                clusterId={clusterId}
                resources={resources}
                kind="ServiceAccount"
                name={s.name}
                namespace={s.namespace}
                apiVersion="v1"
              />
            ) : (
              s.name
            ),
            s.namespace,
          ])}
          empty="No subjects."
        />
      </Part>
    </>
  );
}
