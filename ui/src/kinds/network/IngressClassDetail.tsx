import { Facts, Part } from "../detail/parts";
import type { DetailProps } from "../registry";
import { ingressClassParameters, isDefaultIngressClass } from "./network";

export function IngressClassDetail({ object }: DetailProps) {
  return (
    <Part title="Ingress class">
      <Facts
        items={[
          ["Controller", object.spec?.controller],
          ["Parameters", ingressClassParameters(object)],
          ["Default", isDefaultIngressClass(object) ? "Yes" : "No"],
        ]}
      />
    </Part>
  );
}
