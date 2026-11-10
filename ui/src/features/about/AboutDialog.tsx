import { getVersion } from "@tauri-apps/api/app";
import { Copy, Telescope, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ShellDialog } from "../../app/ShellDialog";
import { Button, IconButton, toast } from "../../design";
import { copyText } from "../../design/clipboard";
import { api } from "../../ipc/api";
import type { AppInfo } from "../../ipc/generated/AppInfo";
import { useShell } from "../../stores/shell";
import styles from "./AboutDialog.module.css";
import { type ComponentRow, components } from "./components";

const UNKNOWN = "unknown";
const TAGLINE = "Open-source desktop Kubernetes IDE";
const NOTICE =
  "Notices for code adapted from other open-source projects are in THIRD_PARTY_NOTICES.md, installed with the app.";

export interface AboutFacts {
  version: string;
  build: string;
  runtime: string;
  platform: string;
  components: ComponentRow[];
  /** What Copy version info writes (spec C §8.1). */
  lines: string[];
}

/** About's facts. `info` is null when `app_info` failed; the version then comes from `getVersion()`. */
export function aboutFacts(
  info: AppInfo | null,
  fallbackVersion: string,
): AboutFacts {
  if (info === null) {
    return {
      version: fallbackVersion,
      build: UNKNOWN,
      runtime: UNKNOWN,
      platform: UNKNOWN,
      components: components(null),
      lines: [
        `SkoposIDE ${fallbackVersion} (unknown build)`,
        `Tauri ${UNKNOWN}`,
        UNKNOWN,
      ],
    };
  }
  const webview = `${info.webview} ${info.webviewVersion ?? UNKNOWN}`;
  const date = info.commitDate ?? UNKNOWN;
  return {
    version: info.version,
    build: info.commit === null ? UNKNOWN : `${info.commit} · ${date}`,
    runtime: `Tauri ${info.tauri} · ${webview}`,
    platform: info.platform,
    components: components(info),
    lines: [
      info.commit === null
        ? `SkoposIDE ${info.version} (unknown build)`
        : `SkoposIDE ${info.version} (${info.commit}, ${date})`,
      `Tauri ${info.tauri} on ${webview}`,
      info.platform,
    ],
  };
}

const FACTS: { label: string; testId: string; value(f: AboutFacts): string }[] =
  [
    { label: "Version", testId: "about-version", value: (f) => f.version },
    { label: "Build", testId: "about-build", value: (f) => f.build },
    { label: "Runtime", testId: "about-runtime", value: (f) => f.runtime },
    { label: "Platform", testId: "about-platform", value: (f) => f.platform },
    { label: "License", testId: "about-license", value: () => "Apache-2.0" },
  ];

/** `app_info`, or after a failure the version from `getVersion()`; null while loading. */
function useAboutFacts(): AboutFacts | null {
  const [facts, setFacts] = useState<AboutFacts | null>(null);
  useEffect(() => {
    let current = true;
    const settle = (value: AboutFacts) => {
      if (current) setFacts(value);
    };
    api.appInfo().then(
      (info) => settle(aboutFacts(info, info.version)),
      () =>
        getVersion().then(
          (version) => settle(aboutFacts(null, version)),
          () => settle(aboutFacts(null, UNKNOWN)),
        ),
    );
    return () => {
      current = false;
    };
  }, []);
  return facts;
}

export function AboutDialog() {
  const open = useShell((s) => s.dialog === "about");
  const close = useShell((s) => s.close);
  return (
    <ShellDialog
      open={open}
      onClose={() => close("about")}
      label="About SkoposIDE"
      testId="about-dialog"
      kind="panel"
    >
      <AboutBody onClose={() => close("about")} />
    </ShellDialog>
  );
}

function AboutBody({ onClose }: { onClose(): void }) {
  const facts = useAboutFacts();

  async function copy(lines: string[]): Promise<void> {
    try {
      await copyText(lines.join("\n"));
      toast.success("Version info copied", lines.join(" · "));
    } catch {
      toast.error("Could not copy the version info");
    }
  }

  return (
    <>
      <div className={styles.header}>
        <div className={styles.tile}>
          <Telescope size={24} aria-hidden="true" />
        </div>
        <div className={styles.titles}>
          <h2 className={styles.title}>SkoposIDE</h2>
          <p className={styles.tagline}>
            {facts === null ? TAGLINE : `${TAGLINE} · Version ${facts.version}`}
          </p>
        </div>
        <IconButton
          label="Close"
          icon={<X size={16} aria-hidden="true" />}
          tooltip={false}
          onClick={onClose}
        />
      </div>
      {facts === null ? null : (
        <div className={styles.body}>
          <dl className={styles.facts}>
            {FACTS.map((f) => (
              <div key={f.testId} className={styles.fact}>
                <dt>{f.label}</dt>
                <dd data-testid={f.testId}>{f.value(facts)}</dd>
              </div>
            ))}
          </dl>
          <h3 className={styles.sectionTitle}>Open-source components</h3>
          <div className={styles.components}>
            <table data-testid="about-components">
              <thead>
                <tr>
                  <th scope="col">Component</th>
                  <th scope="col">Version</th>
                  <th scope="col">License</th>
                </tr>
              </thead>
              <tbody>
                {facts.components.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td>{c.version}</td>
                    <td>{c.license}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.notice}>{NOTICE}</p>
        </div>
      )}
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={facts === null}
          onClick={() => {
            if (facts !== null) void copy(facts.lines);
          }}
          data-testid="about-copy"
        >
          <Copy size={16} aria-hidden="true" />
          Copy version info
        </Button>
        <Button variant="primary" onClick={onClose} data-testid="about-close">
          Close
        </Button>
      </div>
    </>
  );
}
