import type { ReactNode } from "react";
import { Chips, Facts, Part } from "../detail/parts";
import type { DetailProps } from "../registry";
import { selectorText } from "../selectors";
import { type PolicyPeer, policyPeerText, policyPortText } from "./network";

interface Rule {
  ports?: Parameters<typeof policyPortText>[0][];
  from?: PolicyPeer[];
  to?: PolicyPeer[];
}

function Direction(props: {
  title: string;
  word: "ingress" | "egress";
  peersKey: "from" | "to";
  rules: Rule[] | undefined;
}) {
  const rules = Array.isArray(props.rules) ? props.rules : [];
  if (rules.length === 0) {
    return (
      <Part title={props.title}>
        <p>{`Denies all ${props.word}`}</p>
      </Part>
    );
  }
  return (
    <Part title={props.title} testId={`detail-policy-${props.word}`}>
      {rules.map((rule, index) => {
        const peers = Array.isArray(rule?.[props.peersKey])
          ? (rule[props.peersKey] as PolicyPeer[])
          : [];
        const ports = Array.isArray(rule?.ports) ? rule.ports : [];
        if (peers.length === 0 && ports.length === 0) {
          // biome-ignore lint/suspicious/noArrayIndexKey: rules have no identity
          return <p key={index}>{`Allows all ${props.word}`}</p>;
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rules have no identity
          <div key={index}>
            <p>
              <strong>Ports</strong>{" "}
              {ports.length > 0
                ? ports.map(policyPortText).join(", ")
                : "all ports"}
            </p>
            <p>
              <strong>{props.peersKey === "from" ? "From" : "To"}</strong>
            </p>
            {peers.length > 0 ? (
              <Chips values={peers.map(policyPeerText)} />
            ) : (
              <p>anywhere</p>
            )}
          </div>
        );
      })}
    </Part>
  );
}

export function NetworkPolicyDetail({ object }: DetailProps) {
  const spec = object.spec ?? {};
  const types: string[] = Array.isArray(spec.policyTypes)
    ? spec.policyTypes
    : // The API defaults to Ingress, and adds Egress when egress rules exist.
      ["Ingress", ...(spec.egress ? ["Egress"] : [])];
  const selector = selectorText(spec.podSelector);
  const selectorNode: ReactNode =
    selector.length > 0 ? (
      <Chips values={selector} />
    ) : (
      "All pods in this namespace"
    );
  return (
    <>
      <Part title="Applies to">
        <Facts
          items={[
            ["Pod selector", selectorNode],
            ["Policy types", types.join(", ")],
          ]}
        />
      </Part>
      {types.includes("Ingress") ? (
        <Direction
          title="Ingress"
          word="ingress"
          peersKey="from"
          rules={spec.ingress}
        />
      ) : null}
      {types.includes("Egress") ? (
        <Direction
          title="Egress"
          word="egress"
          peersKey="to"
          rules={spec.egress}
        />
      ) : null}
    </>
  );
}
